package service

import (
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	hlsQueueKey      = "cloud:hls:queue"
	hlsProcessingKey = "cloud:hls:processing"
	hlsRetryKey      = "cloud:hls:retry" // ZSET: upload_uuid -> next attempt (unix seconds)
	hlsJobKeyPfx     = "cloud:hls:job:"
	hlsLeasePfx      = "cloud:hls:lease:"
	hlsAttemptsPfx   = "cloud:hls:attempts:"
	hlsStatusPfx     = "cloud:hls:status:"
	hlsTokenPfx      = "cloud:hls:token:"
	hlsTokenSetPfx   = "cloud:hls:tokset:"
	hlsGonePfx       = "cloud:hls:gone:"
	hlsGCKey         = "cloud:hls:gc" // ZSET: due superseded-version cleanup
	hlsPlaylistKey   = "index.m3u8"
	hlsMasterKey     = "master.m3u8"

	// Status TTL is both the cache lifetime and the "already packaged" memory.
	// 30 days (refreshed on every successful playback descriptor mint) keeps a
	// watched file from being re-packaged just because it sat idle for a week;
	// once it does expire, GET /hls lazily re-enqueues instead of faking a
	// perpetual "processing" state. Output objects live in MinIO regardless.
	hlsStatusTTL   = 30 * 24 * time.Hour
	hlsJobKeyTTL   = 24 * time.Hour
	hlsGoneTTL     = 24 * time.Hour
	hlsAttemptsTTL = 24 * time.Hour
	hlsBaseBackoff = 30 * time.Second
	hlsMaxBackoff  = 10 * time.Minute

	hlsStateQueued      = "queued"
	hlsStateProcessing  = "processing"
	hlsStateReady       = "ready"
	hlsStateFailed      = "failed"
	hlsStateUnsupported = "unsupported"
	// hlsStateNotStarted is a truthful "there is no packaging job" answer:
	// the video was never enqueued and lazy enqueue is disabled. It is NOT a
	// transient state, so clients should keep playing the original MP4.
	hlsStateNotStarted = "not_started"
	// hlsStateUnknown means packaging state could not be read (Redis failure).
	// Reported instead of pretending the file is being packaged.
	hlsStateUnknown = "unknown"

	// Coarse progress percentages (status transitions; no per-frame ffmpeg
	// progress parsing on purpose — the stage is what the viewer needs).
	hlsProgressQueued   = 0
	hlsProgressDownload = 10
	hlsProgressProbe    = 18
	hlsProgressPackage  = 25
	hlsProgressUpload   = 80
	hlsProgressReady    = 100
)

var releaseLeaseScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`)

type hlsJob struct {
	UID        int64  `json:"uid"`
	UploadUUID string `json:"uploadUuid"`
}

type hlsStatus struct {
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
	Prefix  string `json:"prefix,omitempty"`
	Version string `json:"version,omitempty"`
	// Playlist is the entry playlist inside the version prefix: index.m3u8 for
	// a single rendition, master.m3u8 for ABR.
	Playlist string `json:"playlist,omitempty"`
	// Cover is a derived poster object (cover.jpg) when thumbnails are enabled.
	Cover     string `json:"cover,omitempty"`
	Progress  int    `json:"progress"`
	Attempts  int    `json:"attempts,omitempty"`
	Retryable bool   `json:"retryable,omitempty"`
	UpdatedAt int64  `json:"updatedAt"`
}

// HLSPlayback is the wire response for GET /cloud/video/{uuid}/hls.
//
// Progress/Attempts/Retryable are only populated on non-ready answers (the
// ready shape stays exactly {ready,status,playlistUrl,expiresIn}).
type HLSPlayback struct {
	Ready       bool   `json:"ready"`
	Status      string `json:"status"`
	PlaylistURL string `json:"playlistUrl,omitempty"`
	PosterURL   string `json:"posterUrl,omitempty"`
	ExpiresIn   int    `json:"expiresIn,omitempty"`
	Progress    int    `json:"progress,omitempty"`
	Attempts    int    `json:"attempts,omitempty"`
	Retryable   bool   `json:"retryable,omitempty"`
}

type hlsTokenPayload struct {
	UID    int64  `json:"uid"`
	UUID   string `json:"uuid"`
	Bucket string `json:"bucket"`
	Prefix string `json:"prefix"`
	// Path is the exact /hls/... URI prefix this token authorizes. It carries
	// the immutable output version so old tokens keep addressing old objects.
	Path string `json:"path"`
	// Bind couples the token to the browser session cookie hls_ctx. A token
	// copied out of storage/logs is useless without the matching cookie.
	Bind string `json:"bind,omitempty"`
	Exp  int64  `json:"exp"`
}

// hlsJobError classifies a packaging failure so the worker knows whether to
// retry, and what terminal status to publish.
type hlsJobError struct {
	err       error
	status    string // terminal status when retryable == false
	retryable bool
}

func (e *hlsJobError) Error() string {
	if e.err != nil {
		return e.err.Error()
	}
	return e.status
}

func transientJobErr(err error) error { return &hlsJobError{err: err, retryable: true} }
func terminalJobErr(err error) error  { return &hlsJobError{err: err} }
func unsupportedJobErr() error        { return &hlsJobError{status: hlsStateUnsupported} }

type hlsProbe struct {
	Format struct {
		FormatName string `json:"format_name"`
		Duration   string `json:"duration"`
	} `json:"format"`
	Streams []struct {
		CodecType   string `json:"codec_type"`
		CodecName   string `json:"codec_name"`
		Width       int    `json:"width"`
		Height      int    `json:"height"`
		PixFmt      string `json:"pix_fmt"`
		Disposition struct {
			AttachedPic int `json:"attached_pic"`
		} `json:"disposition"`
		SideDataList []struct {
			Rotation float64 `json:"rotation"`
		} `json:"side_data_list"`
	} `json:"streams"`
}

// videoStream returns the first real video stream. Rotation matters: MPEG-TS
// copies lose the display matrix, so a rotated phone video must be re-encoded
// (ffmpeg autorotate) instead of remuxed. 10-bit/mixed pixel formats likewise
// cannot be copied if browsers are expected to decode them.
func (p hlsProbe) videoStream() (codec, pixFmt string, width, height int, rotation float64, ok bool) {
	for _, st := range p.Streams {
		if st.CodecType != "video" || st.Disposition.AttachedPic != 0 {
			continue
		}
		for _, sd := range st.SideDataList {
			if sd.Rotation != 0 {
				rotation = sd.Rotation
				break
			}
		}
		return st.CodecName, st.PixFmt, st.Width, st.Height, rotation, true
	}
	return "", "", 0, 0, 0, false
}

func (p hlsProbe) audioCodecs() []string {
	var out []string
	for _, st := range p.Streams {
		if st.CodecType == "audio" {
			out = append(out, st.CodecName)
		}
	}
	return out
}

func (p hlsProbe) duration() float64 {
	if d, err := strconv.ParseFloat(p.Format.Duration, 64); err == nil && d > 0 {
		return d
	}
	return 0
}

type hlsRendition struct {
	Height    int  // target height; 0 = keep source resolution
	CopyVideo bool // remux instead of re-encoding video
	CopyAudio bool // remux instead of re-encoding audio
	Width     int  // display width used in the master playlist
}

type hlsPlan struct {
	Renditions []hlsRendition
	Duration   float64
}

// hlsGCEntry marks one published version whose superseded versions may be
// deleted once all tokens minted against them have expired.
type hlsGCEntry struct {
	UID         int64  `json:"uid"`
	UploadUUID  string `json:"uploadUuid"`
	Version     string `json:"version"`
	PublishedAt int64  `json:"publishedAt"`
}
