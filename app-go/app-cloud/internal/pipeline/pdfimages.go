package pipeline

// Embedded-image extraction for image-only (scanned) PDFs. The text extractor
// reports ErrEmptyPDFText for those documents; the OCR path then pulls the
// page images out with pdfcpu (pure Go — no cgo, no external binaries) and
// hands them to the vision model.
//
// Bounds come from the OCR config: at most maxPages pages are inspected, at
// most maxImages images are returned and any image larger than maxBytes is
// skipped (it could not be sent to the gateway anyway).

import (
	"bytes"
	"fmt"
	"io"
	"sort"

	"app-cloud/internal/config"

	"github.com/pdfcpu/pdfcpu/pkg/api"
)

// PDFImage is one image extracted from a PDF page, in page order.
type PDFImage struct {
	Data     []byte
	MimeType string
	Page     int // 1-based page number
}

// pdfImageExtractor extracts page images from a PDF. Injected into the engine
// so tests can exercise the OCR assembly without binary PDF fixtures.
type pdfImageExtractor func(data []byte, maxPages, maxImages int, maxBytes int64) ([]PDFImage, error)

// extractPDFImagesPDFCPU implements pdfImageExtractor with pdfcpu: pages are
// visited in document order and each page's images are read in resource order.
func extractPDFImagesPDFCPU(data []byte, maxPages, maxImages int, maxBytes int64) ([]PDFImage, error) {
	if maxPages <= 0 {
		maxPages = config.DefaultOCRMaxPDFPages
	}
	if maxImages <= 0 {
		maxImages = config.DefaultOCRMaxImages
	}
	if maxBytes <= 0 {
		maxBytes = config.DefaultOCRMaxImageBytes
	}
	// Page selection also bounds the work pdfcpu performs before decoding.
	pages, err := api.ExtractImagesRaw(bytes.NewReader(data),
		[]string{fmt.Sprintf("1-%d", maxPages)}, nil)
	if err != nil {
		return nil, fmt.Errorf("pdfcpu extract images: %w", err)
	}
	out := make([]PDFImage, 0, maxImages)
	for pageIdx, imageMap := range pages {
		keys := make([]int, 0, len(imageMap))
		for k := range imageMap {
			keys = append(keys, k)
		}
		sort.Ints(keys)
		for _, k := range keys {
			img := imageMap[k]
			if img.Thumb || img.IsImgMask {
				continue // thumbnails/masks carry no readable page content
			}
			mime := PDFImageMime(img.FileType)
			if mime == "" {
				continue // e.g. JPX/CCITT output the vision gateway rejects
			}
			if img.Reader == nil {
				continue
			}
			raw, rerr := io.ReadAll(io.LimitReader(img.Reader, maxBytes+1))
			if rerr != nil || len(raw) == 0 || int64(len(raw)) > maxBytes {
				continue
			}
			out = append(out, PDFImage{Data: raw, MimeType: mime, Page: pageIdx + 1})
			if len(out) >= maxImages {
				return out, nil
			}
		}
	}
	return out, nil
}
