create table async_tasks
(
    id           int auto_increment
        primary key,
    task_id      varchar(64) not null,
    task_type    varchar(20) not null,
    target       json        not null,
    status       varchar(20) null,
    progress     int         null,
    steps        json        null,
    result       json        null,
    error        text        null,
    created_at   datetime    null,
    updated_at   datetime    null,
    completed_at datetime    null,
    uid          bigint      null,
    constraint ix_async_tasks_task_id
        unique (task_id)
);

create table chat_sessions
(
    id              int auto_increment
        primary key,
    chat_session_id varchar(64)  not null,
    title           varchar(200) null,
    status          varchar(20)  null,
    created_at      datetime     null,
    updated_at      datetime     null,
    last_message_at datetime     null,
    uid             bigint       not null,
    constraint ix_chat_sessions_chat_session_id
        unique (chat_session_id)
);

create table collection
(
    id         int auto_increment
        primary key,
    media_id   bigint       not null,
    bvid       varchar(20)  not null,
    cid        bigint       null,
    title      varchar(500) not null,
    cover      varchar(500) null,
    duration   int          null,
    owner_name varchar(100) null,
    owner_mid  bigint       null,
    description text        null,
    created_at datetime     null,
    updated_at datetime     null,
    constraint uq_collection_media_bvid
        unique (media_id, bvid)
);

create index ix_collection_media_id
    on collection (media_id);

create table credential_usage
(
    id                int auto_increment
        primary key,
    credential_id     int              null,
    provider          varchar(32)      null,
    model             varchar(64)      null,
    prompt_tokens     int              null,
    completion_tokens int              null,
    total_tokens      int              null,
    api_calls         int              null,
    created_at        timestamp default CURRENT_TIMESTAMP null,
    uid               bigint not null
);

create table favorite_folders
(
    id           int auto_increment
        primary key,
    session_id   varchar(64)          null,
    media_id     bigint               not null,
    fid          bigint               null,
    title        varchar(200)         not null,
    media_count  int                  null,
    is_selected  tinyint(1)           null,
    last_sync_at datetime             null,
    created_at   datetime             null,
    updated_at   datetime             null,
    uid          bigint               null,
    is_default   tinyint(1) default 0 null,
    deleted_at   timestamp            null,
    constraint uq_fav_folder_uid_media
        unique (uid, media_id)
);

create index ix_favorite_folders_session_id
    on favorite_folders (session_id);

create table quiz_answers
(
    id                      int auto_increment
        primary key,
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
    graded_at               datetime    null
);

create index ix_quiz_answers_question_uuid
    on quiz_answers (question_uuid);

create index ix_quiz_answers_submission_uuid
    on quiz_answers (submission_uuid);

create table quiz_sets
(
    id                int auto_increment
        primary key,
    quiz_uuid         varchar(64)  not null,
    title             varchar(200) not null,
    description       text         null,
    question_count    int          null,
    type_distribution json         null,
    difficulty        varchar(20)  null,
    folder_ids        json         null,
    source_type       varchar(20)  null,
    source_pages      json         null,
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
    constraint ix_quiz_sets_quiz_uuid
        unique (quiz_uuid),
    constraint uq_quiz_sets_share_token
        unique (share_token)
);

create table quiz_submissions
(
    id                   int auto_increment
        primary key,
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
    constraint ix_quiz_submissions_submission_uuid
        unique (submission_uuid)
);

create index ix_quiz_submissions_quiz_uuid
    on quiz_submissions (quiz_uuid);

create table rbac_role
(
    role_id     varchar(64) not null
        primary key,
    name        varchar(50) not null,
    description text        null,
    is_system   tinyint(1)  null,
    created_at  datetime    null,
    updated_at  datetime    null
);

create table users
(
    uid            bigint auto_increment
        primary key,
    status         varchar(20)          null,
    created_at     datetime             null,
    updated_at     datetime             null,
    deleted_at     datetime             null,
    email          varchar(200)         null,
    phone          varchar(20)          null,
    password_hash  varchar(255)         null,
    email_verified tinyint(1) default 0 null,
    phone_verified tinyint(1) default 0 null,
    constraint email
        unique (email),
    constraint phone
        unique (phone)
);

create table rbac_user_role
(
    id         int auto_increment
        primary key,
    uid        bigint      not null,
    role_id    varchar(64) not null,
    granted_by bigint      null,
    granted_at datetime    null,
    expires_at datetime    null,
    is_active  tinyint(1)  null,
    created_at datetime    null,
    constraint rbac_user_role_ibfk_1
        foreign key (uid) references users (uid),
    constraint rbac_user_role_ibfk_2
        foreign key (role_id) references rbac_role (role_id)
);

create index role_id
    on rbac_user_role (role_id);

create index uid
    on rbac_user_role (uid);

create table user_asr_configs
(
    id                int auto_increment
        primary key,
    uid               bigint      not null,
    name              varchar(64) not null,
    provider          varchar(32) not null,
    api_key_encrypted text        not null,
    base_url          text        null,
    model             text        null,
    is_default        tinyint(1)  null,
    last_test_status  varchar(20) null,
    last_test_error   text        null,
    last_test_at      datetime    null,
    created_at        datetime    null,
    updated_at        datetime    null,
    deleted_at        datetime    null,
    constraint user_asr_configs_ibfk_1
        foreign key (uid) references users (uid)
);

create index ix_user_asr_configs_uid
    on user_asr_configs (uid);

create table user_credentials
(
    id                int auto_increment
        primary key,
    uid               bigint                              not null,
    name              varchar(64)                         not null,
    provider          varchar(32)                         not null,
    api_key_encrypted text                                not null,
    base_url          text                                null,
    default_model     text                                null,
    is_default        tinyint(1) default 0                null,
    last_test_status  varchar(20)                         null,
    last_test_error   text                                null,
    last_test_at      datetime                            null,
    created_at        timestamp default CURRENT_TIMESTAMP null,
    updated_at        timestamp default CURRENT_TIMESTAMP null on update CURRENT_TIMESTAMP,
    deleted_at        timestamp                           null,
    constraint user_credentials_ibfk_1
        foreign key (uid) references users (uid)
);

create index idx_user_credentials_uid
    on user_credentials (uid);

create table user_device
(
    device_id       varchar(64)  not null
        primary key,
    uid             bigint       not null,
    device_type     varchar(20)  null,
    device_name     varchar(100) null,
    os              varchar(50)  null,
    os_version      varchar(50)  null,
    browser         varchar(100) null,
    browser_version varchar(50)  null,
    fingerprint     varchar(128) null,
    trust_level     varchar(20)  null,
    last_active_at  datetime     null,
    created_at      datetime     null,
    deleted_at      datetime     null,
    constraint uid
        unique (uid, fingerprint),
    constraint user_device_ibfk_1
        foreign key (uid) references users (uid)
);

create index idx_user_device_uid
    on user_device (uid);

create table user_embedding_configs
(
    id                int auto_increment
        primary key,
    uid               bigint      not null,
    name              varchar(64) not null,
    provider          varchar(32) not null,
    api_key_encrypted text        not null,
    base_url          text        null,
    model             text        null,
    is_default        tinyint(1)  null,
    last_test_status  varchar(20) null,
    last_test_error   text        null,
    last_test_at      datetime    null,
    created_at        datetime    null,
    updated_at        datetime    null,
    deleted_at        datetime    null,
    constraint user_embedding_configs_ibfk_1
        foreign key (uid) references users (uid)
);

create index ix_user_embedding_configs_uid
    on user_embedding_configs (uid);

create table user_oauth
(
    id            int auto_increment
        primary key,
    uid           bigint       not null,
    provider      varchar(32)  not null,
    provider_uid  varchar(64)  not null,
    union_id      varchar(64)  null,
    access_token  text         null,
    refresh_token text         null,
    expires_at    datetime     null,
    raw_data      text         null,
    is_primary    tinyint(1)   null,
    created_at    datetime     null,
    updated_at    datetime     null,
    deleted_at    datetime     null,
    email         varchar(200) null,
    constraint uq_user_oauth_provider_uid
        unique (provider, provider_uid),
    constraint user_oauth_ibfk_1
        foreign key (uid) references users (uid)
);

create index uid
    on user_oauth (uid);

create table user_profile
(
    uid        bigint       not null
        primary key,
    nickname   varchar(100) null,
    avatar     varchar(500) null,
    bio        text         null,
    birthday   date         null,
    gender     varchar(10)  null,
    location   varchar(100) null,
    timezone   varchar(50)  null,
    language   varchar(20)  null,
    created_at datetime     null,
    updated_at datetime     null,
    deleted_at datetime     null,
    constraint user_profile_ibfk_1
        foreign key (uid) references users (uid)
);

create table user_tokens
(
    session_token  varchar(128) not null
        primary key,
    uid            bigint       not null,
    device_id      varchar(64)  null,
    token_type     varchar(20)  null,
    expires_at     datetime     null,
    ip             varchar(64)  null,
    user_agent     text         null,
    is_revoked     tinyint(1)   null,
    last_active_at datetime     null,
    created_at     datetime     null,
    deleted_at     datetime     null,
    constraint user_tokens_ibfk_1
        foreign key (uid) references users (uid)
);

create index uid
    on user_tokens (uid);

create table verification_codes
(
    id         int auto_increment
        primary key,
    uid        bigint       not null,
    target     varchar(200) not null,
    type       varchar(20)  not null,
    purpose    varchar(32)  not null,
    code       varchar(64)  not null,
    expires_at datetime     not null,
    used       tinyint(1)   null,
    attempts   int          default 0 null,
    created_at datetime     null,
    constraint verification_codes_ibfk_1
        foreign key (uid) references users (uid)
);

create index idx_vc_target_purpose
    on verification_codes (target, purpose);

create index idx_vc_uid
    on verification_codes (uid);

create table login_attempts
(
    id             int auto_increment
        primary key,
    uid            bigint       null,
    email          varchar(200) null,
    ip             varchar(64)  not null,
    device_id      varchar(64)  null,
    success        tinyint(1) default 0 not null,
    failure_reason varchar(100) null,
    created_at     datetime     not null
);

create index idx_la_ip_created
    on login_attempts (ip, created_at);

create index idx_la_email_created
    on login_attempts (email, created_at);

create index idx_la_uid_created
    on login_attempts (uid, created_at);

create table video
(
    id                 int auto_increment
        primary key,
    bvid               varchar(20)  not null,
    cid                bigint       not null,
    page_index         int          not null,
    page_title         varchar(500) null,
    content_source     varchar(20)  null,
    is_processed       tinyint(1)   null,
    version            int          null,
    is_vectorized      varchar(20)  null,
    vectorized_at      datetime     null,
    vector_chunk_count int          null,
    vector_error       text         null,
    created_at         datetime     null,
    updated_at         datetime     null,
    constraint uq_video_bvid_cid
        unique (bvid, cid),
    constraint uq_video_bvid_index
        unique (bvid, page_index)
);

create table arc_meta
(
    id           int auto_increment
        primary key,
    video_id     int         not null,
    summary      text        null,
    keywords     json        null,
    topics       json        null,
    difficulty   varchar(20) null,
    word_count   int         null,
    reading_time int         null,
    language     varchar(10) null,
    has_code     tinyint(1)  null,
    has_math     tinyint(1)  null,
    is_tutorial  tinyint(1)  null,
    user_tags    json        null,
    notes        text        null,
    extracted_at datetime    null,
    created_at   datetime    null,
    updated_at   datetime    null,
    constraint ix_arc_meta_video_id
        unique (video_id),
    constraint arc_meta_ibfk_1
        foreign key (video_id) references video (id)
            on delete cascade
);

create index ix_video_bvid
    on video (bvid);

create table video_versions
(
    id             int auto_increment
        primary key,
    bvid           varchar(20) not null,
    cid            bigint      null,
    page_index     int         not null,
    version        int         not null,
    content_source varchar(20) null,
    is_latest      tinyint(1)  null,
    created_at     datetime    null,
    constraint uq_video_version
        unique (bvid, cid, version)
);

create index ix_video_versions_bvid
    on video_versions (bvid);

create table cloud_folders
(
    id         int auto_increment
        primary key,
    uid        bigint       not null,
    parent_id  int          null,
    name       varchar(200) not null,
    video_count int         null,
    sort_order int          null,
    created_at datetime     null,
    updated_at datetime     null,
    deleted_at datetime     null,
    constraint cloud_folders_ibfk_1
        foreign key (uid) references users (uid),
    constraint cloud_folders_ibfk_2
        foreign key (parent_id) references cloud_folders (id)
);

create index ix_cloud_folders_uid
    on cloud_folders (uid);

create table cloud_files
(
    id                 int auto_increment
        primary key,
    upload_uuid        varchar(64)  not null,
    uid                bigint       not null,
    folder_id          int          null,
    original_name      varchar(500) not null,
    file_size          bigint       not null,
    mime_type          varchar(128)  not null,
    duration           int          null,
    bucket             varchar(64)  not null,
    object_key         varchar(500) not null,
    etag               varchar(64)  null,
    upload_status      varchar(20)  null,
    asr_status         varchar(20)  null,
    vector_status      varchar(20)  null,
    vector_chunk_count int          null,
    title              varchar(500) null,
    description        text         null,
    cover_url          varchar(500) null,
    tags               json         null,
    vectorizable       tinyint(1)   not null default 1,
    doc_parser         varchar(20)  null,
    doc_meta           json         null,
    content_hash       varchar(128) null,
    created_at         datetime     null,
    updated_at         datetime     null,
    deleted_at         datetime     null,
    constraint uq_cloud_files_uuid
        unique (upload_uuid),
    constraint cloud_files_ibfk_1
        foreign key (uid) references users (uid),
    constraint cloud_files_ibfk_2
        foreign key (folder_id) references cloud_folders (id)
);

create index ix_cloud_files_uid
    on cloud_files (uid);

create index ix_cloud_files_upload_uuid
    on cloud_files (upload_uuid);

create table cloud_upload_chunks
(
    id              int auto_increment
        primary key,
    upload_uuid     varchar(64)  not null,
    chunk_index     int          not null,
    chunk_size      bigint       not null,
    minio_upload_id varchar(128) null,
    upload_url      text         null,
    upload_status   varchar(20)  null,
    etag            varchar(64)  null,
    retry_count     int          null,
    last_heartbeat  datetime     null,
    created_at      datetime     null,
    updated_at      datetime     null,
    constraint uq_cloud_chunks
        unique (upload_uuid, chunk_index)
);

create index ix_cloud_upload_chunks_upload_uuid
    on cloud_upload_chunks (upload_uuid);

create table cloud_upload_sessions
(
    id              int auto_increment
        primary key,
    session_uuid    varchar(64)  not null,
    uid             bigint       not null,
    minio_upload_id varchar(128) null,
    total_files     int          null,
    completed_files int          null,
    status          varchar(20)  null,
    last_heartbeat  datetime     null,
    created_at      datetime     null,
    updated_at      datetime     null,
    constraint uq_upload_session
        unique (session_uuid),
    constraint cloud_upload_sessions_ibfk_1
        foreign key (uid) references users (uid)
);

create index ix_cloud_upload_sessions_uid
    on cloud_upload_sessions (uid);

-- Plan 0023: Workspaces

create table workspaces
(
    id          int auto_increment primary key,
    uid         bigint       not null,
    name        varchar(200) not null,
    description text         null,
    icon        varchar(50)  null,
    color       varchar(20)  null,
    file_count  int          default 0,
    chunk_count int          default 0,
    created_at  datetime     null,
    updated_at  datetime     null,
    deleted_at  datetime     null,
    constraint workspaces_ibfk_1
        foreign key (uid) references users (uid)
);

create index ix_workspaces_uid
    on workspaces (uid);

create index ix_workspaces_active
    on workspaces (uid, deleted_at);

-- Plan 0023: Workspace bindings

create table workspace_bindings
(
    id                 int auto_increment primary key,
    workspace_id       int         not null,
    uid                bigint      not null,
    bind_type          varchar(10) not null,
    folder_id          int         null,
    upload_uuid        varchar(64) null,
    include_subfolders tinyint(1)  default 1,
    created_at         datetime    null,
    constraint workspace_bindings_ibfk_1
        foreign key (workspace_id) references workspaces (id) on delete cascade,
    constraint workspace_bindings_ibfk_2
        foreign key (uid) references users (uid),
    constraint workspace_bindings_ibfk_3
        foreign key (folder_id) references cloud_folders (id)
);

create index ix_wb_workspace
    on workspace_bindings (workspace_id);

create index ix_wb_uid
    on workspace_bindings (uid);

create index ix_wb_folder
    on workspace_bindings (folder_id);

create index ix_wb_upload_uuid
    on workspace_bindings (upload_uuid);

-- Notes — user-authored markdown notes (metadata only; content in MongoDB)

create table notes
(
    id             int auto_increment
        primary key,
    uuid           varchar(36)  not null,
    uid            bigint       not null,
    title          varchar(500) not null default '无标题',
    target_type    varchar(20)  not null,
    target_id      varchar(100) not null,
    content_doc_id varchar(64)  not null,
    content_length int          default 0 null,
    content_hash   varchar(64)  null,
    revision_count int          default 0 null,
    is_pinned      tinyint(1)   default 0 null,
    is_deleted     tinyint(1)   default 0 null,
    created_at     datetime     null,
    updated_at     datetime     null,
    constraint uq_notes_uuid
        unique (uuid),
    constraint notes_ibfk_1
        foreign key (uid) references users (uid)
);

create index ix_notes_uid
    on notes (uid);

create index ix_notes_target_id
    on notes (target_id);

create index ix_notes_uid_target
    on notes (uid, target_type, target_id);

create table note_anchors
(
    id         int auto_increment
        primary key,
    note_id    int          not null,
    block_id   varchar(50)  not null,
    position   int          not null,
    label      varchar(200) null,
    created_at datetime     null,
    constraint note_anchors_ibfk_1
        foreign key (note_id) references notes (id) on delete cascade
);

create index ix_note_anchors_note_id
    on note_anchors (note_id);

create table note_shares
(
    id             int auto_increment
        primary key,
    note_uuid      varchar(36) not null,
    share_token    varchar(64) not null,
    created_by_uid bigint      not null,
    expires_at     datetime    null,
    view_count     int         default 0 null,
    is_revoked     tinyint(1)  default 0 null,
    created_at     datetime    null,
    constraint uq_note_shares_token
        unique (share_token),
    constraint note_shares_ibfk_1
        foreign key (note_uuid) references notes (uuid) on delete cascade,
    constraint note_shares_ibfk_2
        foreign key (created_by_uid) references users (uid)
);

create index ix_note_shares_note_uuid
    on note_shares (note_uuid);
