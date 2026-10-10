/** Shared HTTP route constants. */

/** Hard cap for document uploads (session docs + cloud docs) */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// ---- multimodal chat attachments ----

export const MAX_IMAGES_PER_TURN = 4;
/** data URL length cap (~1.5MB binary per image after base64 overhead) */
export const MAX_IMAGE_DATA_URL_CHARS = 2 * 1024 * 1024;
export const DATA_URL_PATTERN = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
