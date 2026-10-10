// Package db initializes the GORM MySQL connection against the SHARED bilirag
// database and applies app-quiz's schema ownership.
//
// Migration policy: CREATE TABLE IF NOT EXISTS only — never ALTER. The quiz
// tables already exist with live data (created by the Python backend via
// db/system.sql and Base.metadata.create_all); GORM AutoMigrate is
// deliberately NOT used because it issues ALTERs that could drift a shared,
// in-production schema. The DDL below mirrors db/system.sql verbatim
// (quiz_questions mirrors the historical Python ORM that created it before
// question content moved to MongoDB — the table is still joined by the
// wrong-answer notebook and export queries, so a fresh deployment needs it).
package db

import (
	"fmt"
	"strings"
	"time"

	"app-quiz/internal/logger"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

var DB *gorm.DB

// Init opens MySQL. dsn may be SQLAlchemy-style (mysql+aiomysql://...).
//
// loc=UTC (unlike app-cloud's loc=Local): the Python quiz stack wrote naive
// UTC datetimes into these DATETIME columns (datetime.now(timezone.utc)), so
// parsed values must be interpreted as UTC for wire-format parity (isoformat
// / str(datetime) rendering) to hold.
func Init(dsn string, maxOpen, maxIdle, maxLife int, debug bool) error {
	gormDSN := toGormDSN(dsn)
	d, err := gorm.Open(mysql.Open(gormDSN), &gorm.Config{Logger: logger.NewGORMLogger(debug)})
	if err != nil {
		return fmt.Errorf("open mysql: %w", err)
	}
	sqlDB, err := d.DB()
	if err != nil {
		return fmt.Errorf("get *sql.DB: %w", err)
	}
	sqlDB.SetMaxOpenConns(maxOpen)
	sqlDB.SetMaxIdleConns(maxIdle)
	sqlDB.SetConnMaxLifetime(time.Duration(maxLife) * time.Second)
	DB = d
	return nil
}

func Close() error {
	if DB == nil {
		return nil
	}
	sqlDB, err := DB.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

// ownedTables is the full set of tables app-quiz may touch with DDL. The
// guard test pins Migrate to exactly this list.
var ownedTables = []string{
	"quiz_sets",
	"quiz_submissions",
	"quiz_answers",
	"quiz_questions",
	"quiz_task",
	"quiz_task_answer",
}

// Migrate creates the quiz schema if (and only if) it does not exist yet.
func Migrate() error {
	for _, ddl := range schemaDDL() {
		if err := DB.Exec(ddl).Error; err != nil {
			return fmt.Errorf("exec ddl: %w", err)
		}
	}
	return nil
}

func schemaDDL() []string {
	return []string{
		`create table if not exists quiz_sets (
			id                int auto_increment primary key,
			quiz_uuid         varchar(64)  not null,
			title             varchar(200) not null,
			description       text         null,
			question_count    int          null,
			type_distribution json         null,
			difficulty        varchar(20)  null,
			folder_ids        json         null,
			source_type       varchar(20)  null,
			source_pages      json         null,
			chat_session_id   varchar(64)  null,
			bvid_count        int          null,
			status            varchar(20)  null,
			error_message     text         null,
			total_score       int          null,
			passing_score     int          null,
			completed_at      datetime     null,
			share_token       varchar(32)  null,
			shared_at         datetime     null,
			share_expires_at  datetime     null,
			quality_metrics   json         null,
			created_at        datetime     null,
			updated_at        datetime     null,
			uid               bigint       null,
			constraint ix_quiz_sets_quiz_uuid unique (quiz_uuid),
			constraint uq_quiz_sets_share_token unique (share_token),
			index ix_quiz_sets_chat_session_id (chat_session_id)
		)`,
		`create table if not exists quiz_submissions (
			id                   int auto_increment primary key,
			submission_uuid      varchar(64) not null,
			quiz_uuid            varchar(64) not null,
			total_score          int         null,
			auto_score           int         null,
			manual_score         int         null,
			passing_score        int         null,
			is_complete          tinyint(1)  null,
			is_passed            tinyint(1)  null,
			correct_count        int         null,
			total_question_count int         null,
			time_spent_seconds   int         null,
			started_at           datetime    null,
			submitted_at         datetime    null,
			graded_at            datetime    null,
			uid                  bigint      null,
			constraint ix_quiz_submissions_submission_uuid unique (submission_uuid),
			index ix_quiz_submissions_quiz_uuid (quiz_uuid)
		)`,
		`create table if not exists quiz_answers (
			id                      int auto_increment primary key,
			submission_uuid         varchar(64) not null,
			question_uuid           varchar(64) not null,
			question_type           varchar(20) not null,
			user_answer             json        not null,
			user_answer_text        text        null,
			is_correct              tinyint(1)  null,
			auto_score              int         null,
			manual_score            int         null,
			final_score             int         null,
			correct_answer_snapshot json        not null,
			matched_keywords        json        null,
			keyword_match_rate      float       null,
			grading_detail          json        null,
			submitted_at            datetime    null,
			graded_at               datetime    null,
			index ix_quiz_answers_question_uuid (question_uuid),
			index ix_quiz_answers_submission_uuid (submission_uuid)
		)`,
		// Legacy mirror of question content (pre-MongoDB layout). Nothing
		// writes it anymore; kept so the wrong-answer notebook and export
		// joins keep working against historical rows.
		`create table if not exists quiz_questions (
			id             int auto_increment primary key,
			quiz_uuid      varchar(64) not null,
			question_uuid  varchar(64) not null,
			bvid           varchar(20) null,
			chunk_id       varchar(20) null,
			source_segment text        null,
			question_type  varchar(20) not null,
			difficulty     varchar(20) null default 'medium',
			question_text  text        not null,
			options        json        null,
			correct_answer json        not null,
			explanation    text        null,
			keywords       json        null,
			answer_template text       null,
			scoring_rubric json        null,
			model_answer   text        null,
			metadata_extra json        null,
			is_valid       tinyint(1)  null default 1,
			invalid_reason text        null,
			created_at     datetime    null,
			constraint uq_quiz_questions_question_uuid unique (question_uuid),
			index ix_quiz_questions_quiz_uuid (quiz_uuid)
		)`,
		// Scheduled-quiz business rows (app/models.py QuizTask / QuizTaskAnswer),
		// ownership moved from the Python backend. The users(uid) FK declared by
		// the Python model is intentionally omitted: the users table belongs to
		// app-auth and may not exist yet at app-quiz boot (a fresh-create FK
		// would abort Migrate). CREATE IF NOT EXISTS is a no-op on live databases.
		`create table if not exists quiz_task (
			id                 int auto_increment primary key,
			task_id            varchar(64)  not null,
			uid                bigint       not null,
			prompt             varchar(500) not null,
			difficulty         varchar(20)  not null default 'medium',
			question_count     int          not null default 1,
			user_email         varchar(255) not null,
			cc_emails          json         null,
			incomplete_message text         null,
			deadline           datetime     null,
			status             varchar(20)  not null default 'generating',
			overdue_emailed    tinyint(1)   not null default 0,
			created_at         datetime     null,
			updated_at         datetime     null,
			constraint uq_quiz_task_task_id unique (task_id),
			index ix_quiz_task_uid (uid),
			index ix_quiz_task_status_deadline (status, deadline)
		)`,
		`create table if not exists quiz_task_answer (
			id             int auto_increment primary key,
			task_id        varchar(64) not null,
			uid            bigint      not null,
			question_index int         not null default 0,
			answer         text        not null,
			is_correct     tinyint(1)  not null,
			submitted_at   datetime    null,
			index ix_quiz_task_answer_task_id (task_id),
			index ix_quiz_task_answer_uid (uid)
		)`,
	}
}

// toGormDSN converts mysql+aiomysql://user:pass@host:port/db
// to user:pass@tcp(host:port)/db?charset=utf8mb4&parseTime=True&loc=UTC.
func toGormDSN(sqlalchemyURL string) string {
	s := sqlalchemyURL
	for _, p := range []string{"mysql+aiomysql://", "mysql+pymysql://", "mysql://"} {
		s = strings.TrimPrefix(s, p)
	}
	atIdx := strings.LastIndex(s, "@")
	if atIdx < 0 {
		return s + "?charset=utf8mb4&parseTime=True&loc=UTC"
	}
	userPass := s[:atIdx]
	hostDB := s[atIdx+1:]
	slashIdx := strings.Index(hostDB, "/")
	if slashIdx < 0 {
		return userPass + "@tcp(" + hostDB + ")/?charset=utf8mb4&parseTime=True&loc=UTC"
	}
	hostPort := hostDB[:slashIdx]
	rest := hostDB[slashIdx+1:]
	if qIdx := strings.Index(rest, "?"); qIdx >= 0 {
		rest = rest[:qIdx]
	}
	return userPass + "@tcp(" + hostPort + ")/" + rest + "?charset=utf8mb4&parseTime=True&loc=UTC"
}
