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
    uid             bigint       null,
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
    created_at        datetime         null,
    uid               bigint default 0 null
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
    deleted_at   timestamp            null
);

create index ix_favorite_folders_session_id
    on favorite_folders (session_id);

create table favorite_videos
(
    id          int auto_increment
        primary key,
    folder_id   int         not null,
    bvid        varchar(20) null,
    is_selected tinyint(1)  null,
    created_at  datetime    null,
    video_id    int         null
);

create index ix_favorite_videos_bvid
    on favorite_videos (bvid);

create index ix_favorite_videos_folder_id
    on favorite_videos (folder_id);

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
    created_at        datetime     null,
    updated_at        datetime     null,
    uid               bigint       null,
    constraint ix_quiz_sets_quiz_uuid
        unique (quiz_uuid)
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

create table user_settings
(
    id                          int auto_increment
        primary key,
    session_id                  varchar(64)      not null,
    llm_api_key_encrypted       text             null,
    llm_base_url                text             null,
    llm_model                   text             null,
    embedding_api_key_encrypted text             null,
    embedding_base_url          text             null,
    embedding_model             text             null,
    asr_api_key_encrypted       text             null,
    asr_base_url                text             null,
    asr_model                   text             null,
    created_at                  datetime         null,
    updated_at                  datetime         null,
    uid                         bigint default 0 null,
    constraint ix_user_settings_session_id
        unique (session_id)
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
    is_default        int       default 0                 null,
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
    code       varchar(10)  not null,
    expires_at datetime     not null,
    used       tinyint(1)   null,
    created_at datetime     null,
    constraint verification_codes_ibfk_1
        foreign key (uid) references users (uid)
);

create index idx_vc_target_purpose
    on verification_codes (target, purpose);

create index idx_vc_uid
    on verification_codes (uid);

create table video
(
    id                 int auto_increment
        primary key,
    video_id           int          null,
    bvid               varchar(20)  not null,
    cid                bigint       null,
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

create index ix_video_video_id
    on video (video_id);

create table video_cache
(
    id             int auto_increment
        primary key,
    bvid           varchar(20)  not null,
    cid            bigint       null,
    title          varchar(500) not null,
    description    text         null,
    owner_name     varchar(100) null,
    owner_mid      int          null,
    content_source varchar(20)  null,
    outline_json   json         null,
    duration       int          null,
    pic_url        varchar(500) null,
    is_processed   tinyint(1)   null,
    process_error  text         null,
    created_at     datetime     null,
    updated_at     datetime     null,
    constraint ix_video_cache_bvid
        unique (bvid)
);

create table video_page_versions
(
    id             int auto_increment
        primary key,
    bvid           varchar(20) not null,
    cid            bigint      null,
    page_index     int         not null,
    version        int         not null,
    content        text        null,
    content_source varchar(20) null,
    is_latest      tinyint(1)  null,
    created_at     datetime    null,
    constraint uq_video_page_version
        unique (bvid, cid, version)
);

create index ix_video_page_versions_bvid
    on video_page_versions (bvid);

create table video_pages
(
    id                 int auto_increment
        primary key,
    bvid               varchar(20)  not null,
    cid                bigint       null,
    page_index         int          not null,
    page_title         varchar(500) null,
    content            text         null,
    content_source     varchar(20)  null,
    is_processed       tinyint(1)   null,
    version            int          null,
    is_vectorized      varchar(20)  null,
    vectorized_at      datetime     null,
    vector_chunk_count int          null,
    vector_error       text         null,
    created_at         datetime     null,
    updated_at         datetime     null,
    constraint uq_video_page_bvid_cid
        unique (bvid, cid),
    constraint uq_video_page_bvid_index
        unique (bvid, page_index)
);

create index ix_video_pages_bvid
    on video_pages (bvid);

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

