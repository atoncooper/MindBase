"""
MindBase 知识库系统

ASR 服务 - 使用 DashScope 录音文件识别
"""

import asyncio
import json
import os
import shutil
import subprocess
import time
from http import HTTPStatus
from typing import Optional, Any
from urllib import request as urlrequest

import httpx
import dashscope
from dashscope.audio.asr import Transcription, Recognition
from dashscope.common.utils import default_headers, join_url
from dashscope.utils.oss_utils import OssUtils
from loguru import logger

from app.config import settings
from app.security.url_validation import validate_public_http_url


class ASRService:
    """音频转文字服务（DashScope）"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        timeout: Optional[int] = None,
    ):
        # Prefer ASR__API_KEY, then LLM__API_KEY (shared DashScope account).
        self.api_key = api_key or settings.asr_api_key
        self.base_url = base_url or settings.dashscope_base_url
        self.model = model or settings.asr_model
        self.timeout = timeout or settings.asr_timeout
        self.local_model = settings.asr_model_local or self.model
        self.input_format = settings.asr_input_format
        # Long-audio: prefer async Transcription (transcription_model); fall
        # back to timed PCM chunk Recognition if upload/Transcription fails.
        # Recognition.call() has no SDK timeout and stalls on multi-minute
        # files — never feed long audio to a single Recognition call.
        self.transcription_model = settings.asr_transcription_model
        self.realtime_max_seconds = settings.asr_realtime_max_seconds
        self.recognition_timeout = settings.asr_recognition_timeout

    def _configure(self) -> None:
        if not self.api_key:
            raise ValueError("未配置 DASHSCOPE API Key")
        dashscope.api_key = self.api_key
        if self.base_url:
            self.base_url = validate_public_http_url(self.base_url)
            dashscope.base_http_api_url = self.base_url

    def _get_output_value(self, output: Any, key: str, default=None):
        if isinstance(output, dict):
            return output.get(key, default)
        return getattr(output, key, default)

    def _transcode_audio_to_pcm(self, file_path: str) -> Optional[str]:
        """转码为 16k s16le PCM，适配 Recognition"""
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            logger.info("未检测到 ffmpeg，无法转码为 PCM")
            return None
        base, _ext = os.path.splitext(file_path)
        pcm_path = base + ".pcm"
        cmd = [
            ffmpeg,
            "-y",
            "-i",
            file_path,
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-ac",
            "1",
            "-ar",
            "16000",
            pcm_path,
        ]
        try:
            result = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            if result.returncode != 0:
                err = (result.stderr or "").strip()
                logger.warning(f"转码 PCM 失败: {err[:200]}")
                return None
            return pcm_path
        except Exception as e:
            logger.warning(f"转码 PCM 异常: {e}")
            return None

    def _transcode_audio_to_wav(self, file_path: str) -> Optional[str]:
        """转码为 16k 单声道 WAV"""
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            logger.info("未检测到 ffmpeg，无法转码为 WAV")
            return None
        base, _ext = os.path.splitext(file_path)
        wav_path = base + ".wav"
        cmd = [
            ffmpeg,
            "-y",
            "-i",
            file_path,
            "-ac",
            "1",
            "-ar",
            "16000",
            "-vn",
            wav_path,
        ]
        try:
            result = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            if result.returncode != 0:
                err = (result.stderr or "").strip()
                logger.warning(f"转码 WAV 失败: {err[:200]}")
                return None
            return wav_path
        except Exception as e:
            logger.warning(f"转码 WAV 异常: {e}")
            return None

    def _probe_duration(self, file_path: str) -> Optional[float]:
        """Probe audio duration in seconds via ffprobe. Returns None on failure."""
        try:
            result = subprocess.run(
                [
                    "ffprobe", "-v", "error",
                    "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    file_path,
                ],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if result.returncode == 0:
                return float(result.stdout.strip())
        except Exception as e:
            logger.debug(f"ffprobe 探测时长失败: {e}")
        return None

    @staticmethod
    def _safe_stop(recognizer: Recognition) -> None:
        """Force-stop a Recognition call to unblock a stalled WebSocket."""
        try:
            recognizer.stop()
        except Exception:
            pass

    def _recognize_with_timeout(
        self, recognizer: Recognition, input_path: str
    ) -> Optional[Any]:
        """Call recognizer.call() with a hard, reliable timeout.

        The SDK's call() has no timeout, and recognizer.stop() joins the
        worker thread -- which also blocks on a stalled WebSocket -- so a
        Timer+stop cannot unblock it. We run call() in a worker thread and
        use future.result(timeout) instead: on timeout the chunk loop moves
        on and the stalled thread is abandoned (one leak per rare stall,
        acceptable). Returns the RecognitionResult, or None on timeout.
        """
        from concurrent.futures import (
            ThreadPoolExecutor,
            TimeoutError as FuturesTimeout,
        )

        ex = ThreadPoolExecutor(max_workers=1)
        future = ex.submit(recognizer.call, input_path)
        try:
            return future.result(timeout=self.recognition_timeout)
        except FuturesTimeout:
            logger.warning(
                f"ASR Recognition 超时({self.recognition_timeout}s), 放弃该调用"
            )
            self._safe_stop(recognizer)  # best-effort; may also block, in a leaked thread
            return None
        finally:
            ex.shutdown(wait=False)  # never block on a possibly-hung worker

    def _prepare_recognition_input(self, file_path: str) -> Optional[str]:
        """按输入格式准备 Recognition 文件"""
        fmt = (self.input_format or "pcm").lower()
        if fmt == "wav":
            return self._transcode_audio_to_wav(file_path)
        return self._transcode_audio_to_pcm(file_path)

    def _recognize_local_file(self, file_path: str) -> Optional[str]:
        """使用 Recognition 直传本地音频"""
        self._configure()
        if not os.path.exists(file_path):
            logger.warning(f"ASR 本地文件不存在: {file_path}")
            return None

        file_size = os.path.getsize(file_path) / (1024 * 1024)
        logger.info(f"[ASR_PERF] 开始识别: file_size={file_size:.2f}MB")

        t0 = time.time()
        input_path = self._prepare_recognition_input(file_path)
        if not input_path:
            return None

        t1 = time.time()
        logger.info(f"[ASR_PERF] 转码完成: 耗时={(t1-t0):.1f}s")

        logger.info(
            f"ASR Recognition 使用模型: {self.model}, format={self.input_format or 'pcm'}"
        )

        try:
            # 批量识别优先用离线模型（更快、更准），实时模型仅用于真正的流式场景
            recognizer = Recognition(
                model=self.model,
                callback=None,
                format=(self.input_format or "pcm"),
                sample_rate=16000,
            )
            # Hard timeout: the SDK's call() blocks forever on a stalled
            # WebSocket; _recognize_with_timeout abandons the call after
            # recognition_timeout so the task fails fast instead of hanging.
            result = self._recognize_with_timeout(recognizer, input_path)
            if result is None:
                logger.warning("ASR Recognition 超时或无结果")
                return None
            t2 = time.time()
            logger.info(f"[ASR_PERF] 云端识别完成: 耗时={(t2-t1):.1f}s")
            logger.info(
                "ASR Recognition 结果: status_code={}, code={}, message={}, request_id={}",
                getattr(result, "status_code", None),
                getattr(result, "code", None),
                getattr(result, "message", None),
                getattr(result, "request_id", None),
            )
            sentences = result.get_sentence() or []
            if isinstance(sentences, dict):
                sentences = [sentences]
            texts = []
            for s in sentences:
                if isinstance(s, dict):
                    t = s.get("text") or ""
                    if t:
                        texts.append(t)
            text = "\n".join(texts).strip() if texts else None
            if text:
                preview = text[:120].replace("\n", " ").strip()
                logger.info(f"ASR Recognition 成功，长度={len(text)}，预览：{preview}")
            t3 = time.time()
            logger.info(f"[ASR_PERF] 总耗时: {(t3-t0):.1f}s")
            return text
        except Exception as e:
            logger.warning(f"ASR Recognition 异常: {e}")
            return None
        finally:
            for path in {file_path, input_path}:
                try:
                    if path and os.path.exists(path):
                        os.remove(path)
                except Exception:
                    logger.debug(f"ASR 临时文件清理失败: {path}")

    def _download_transcription(self, url: str) -> Optional[str]:
        try:
            safe_url = validate_public_http_url(url)
            if safe_url is None:
                return None
            raw = urlrequest.urlopen(safe_url, timeout=30).read().decode("utf-8")
            data = json.loads(raw)
        except Exception as e:
            logger.warning(f"ASR 结果下载失败: {e}")
            return None

        texts = []
        transcripts = data.get("transcripts") or []
        for item in transcripts:
            text = item.get("text", "") or ""
            if text:
                texts.append(text)
                continue
            for s in item.get("sentences", []) or []:
                s_text = s.get("text", "") or ""
                if s_text:
                    texts.append(s_text)

        if not texts and isinstance(data.get("text"), str):
            texts.append(data["text"])

        return "\n".join(texts).strip() if texts else None

    def _build_api_url(self, *parts: str) -> str:
        base_url = self.base_url or getattr(dashscope, "base_http_api_url", None)
        if not base_url:
            base_url = "https://dashscope.aliyuncs.com/api/v1"
        base_url = validate_public_http_url(base_url)
        if base_url is None:
            raise ValueError("未配置 ASR API 地址")
        return join_url(base_url, *parts)

    def _submit_transcription_task_restful(
        self, audio_url: str, model: str
    ) -> Optional[str]:
        url = self._build_api_url("services", "audio", "asr", "transcription")
        headers = {
            **default_headers(self.api_key),
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
        }
        parameters = {}
        if "paraformer" in model:
            parameters["language_hints"] = ["zh", "en"]
        payload = {"model": model, "input": {"file_urls": [audio_url]}}
        if parameters:
            payload["parameters"] = parameters

        try:
            resp = httpx.post(url, json=payload, headers=headers, timeout=30.0)
        except Exception as e:
            logger.warning(f"ASR RESTful 提交失败: {e}")
            return None

        if resp.status_code != HTTPStatus.OK:
            logger.warning(
                f"ASR RESTful 提交失败: status_code={resp.status_code}, body={resp.text[:300]}"
            )
            return None

        data = resp.json()
        task_id = data.get("task_id")
        if not task_id:
            output = data.get("output") if isinstance(data, dict) else None
            if isinstance(output, dict):
                task_id = output.get("task_id")
        return task_id

    def _fetch_transcription_task_restful(self, task_id: str) -> Optional[dict]:
        url = self._build_api_url("tasks", task_id)
        headers = default_headers(self.api_key)
        try:
            resp = httpx.get(url, headers=headers, timeout=30.0)
        except Exception as e:
            logger.warning(f"ASR RESTful 查询失败: {e}")
            return None

        if resp.status_code != HTTPStatus.OK:
            logger.warning(
                f"ASR RESTful 查询失败: status_code={resp.status_code}, body={resp.text[:300]}"
            )
            return None

        data = resp.json()
        if isinstance(data, dict) and isinstance(data.get("output"), dict):
            return data["output"]
        return data if isinstance(data, dict) else None

    def _transcribe_sync_restful(self, audio_url: str, model: str) -> Optional[str]:
        self._configure()
        task_id = self._submit_transcription_task_restful(audio_url, model)
        if not task_id:
            logger.warning("ASR RESTful 未返回 task_id")
            return None
        logger.info(f"ASR 任务已提交(RESTful): task_id={task_id}")

        start = time.time()
        output = None
        while True:
            if time.time() - start > self.timeout:
                logger.warning("ASR 任务超时(RESTful)")
                return None
            output = self._fetch_transcription_task_restful(task_id)
            if not output:
                time.sleep(1.5)
                continue
            status = self._get_output_value(output, "task_status")
            if status in ("SUCCEEDED", "FAILED"):
                break
            time.sleep(1.5)

        results = self._get_output_value(output, "results", []) or []
        status_message = self._get_output_value(output, "status_message")
        logger.info(
            "ASR 任务状态(RESTful): task_id={}, task_status={}, status_code={}, status_message={}, results={}",
            task_id,
            self._get_output_value(output, "task_status"),
            HTTPStatus.OK,
            status_message,
            len(results),
        )
        for item in results:
            sub_status = item.get("subtask_status")
            transcription_url = item.get("transcription_url")
            error_message = item.get("error_message") or item.get("message")
            if sub_status:
                logger.info(
                    "ASR 子任务状态(RESTful): task_id={}, subtask_status={}, has_url={}, error={}",
                    task_id,
                    sub_status,
                    bool(transcription_url),
                    error_message,
                )
            if sub_status == "SUCCEEDED" and transcription_url:
                return self._download_transcription(transcription_url)

        logger.warning("ASR 未返回有效转写结果(RESTful)")
        return None

    def _transcribe_sync(self, audio_url: str) -> Optional[str]:
        self._configure()
        if audio_url.startswith("oss://"):
            return self._transcribe_sync_restful(audio_url, self.model)

        kwargs = {}
        if "paraformer" in self.model:
            kwargs["language_hints"] = ["zh", "en"]

        try:
            resp = Transcription.async_call(
                model=self.model,
                file_urls=[audio_url],
                **kwargs,
            )
        except Exception as e:
            logger.warning(f"ASR 提交失败: {e}")
            return None

        output = getattr(resp, "output", None)
        task_id = self._get_output_value(output, "task_id")
        if not task_id:
            logger.warning("ASR 未返回 task_id")
            return None
        logger.info(f"ASR 任务已提交: task_id={task_id}")

        start = time.time()
        while True:
            status = self._get_output_value(output, "task_status")
            if status in ("SUCCEEDED", "FAILED"):
                break
            if time.time() - start > self.timeout:
                logger.warning("ASR 任务超时")
                return None
            time.sleep(1.5)
            resp = Transcription.fetch(task=task_id)
            output = getattr(resp, "output", None)

        status_code = getattr(resp, "status_code", None)
        if status_code != HTTPStatus.OK:
            logger.warning(f"ASR 请求失败: status_code={status_code}")
            return None

        results = self._get_output_value(output, "results", []) or []
        status_message = self._get_output_value(output, "status_message")
        logger.info(
            "ASR 任务状态: task_id={}, task_status={}, status_code={}, status_message={}, results={}",
            task_id,
            self._get_output_value(output, "task_status"),
            status_code,
            status_message,
            len(results),
        )
        for item in results:
            sub_status = item.get("subtask_status")
            transcription_url = item.get("transcription_url")
            error_message = item.get("error_message") or item.get("message")
            if sub_status:
                logger.info(
                    "ASR 子任务状态: task_id={}, subtask_status={}, has_url={}, error={}",
                    task_id,
                    sub_status,
                    bool(transcription_url),
                    error_message,
                )
            if sub_status == "SUCCEEDED" and transcription_url:
                return self._download_transcription(item["transcription_url"])

        logger.warning("ASR 未返回有效转写结果")
        return None

    def _upload_temp_file(
        self, file_path: str, model: Optional[str] = None
    ) -> Optional[str]:
        """上传本地文件到 DashScope 临时 OSS，返回 oss:// URL"""
        self._configure()
        if not os.path.exists(file_path):
            logger.warning(f"ASR 本地文件不存在: {file_path}")
            return None
        try:
            upload_model = model or self.local_model or self.model
            oss_url = OssUtils.upload(
                model=upload_model,
                file_path=file_path,
                api_key=self.api_key,
            )
            logger.info(f"ASR 临时文件上传成功: {oss_url}")
            return oss_url
        except Exception as e:
            logger.warning(f"ASR 临时文件上传失败: {e}")
            return None

    async def transcribe_url(self, audio_url: str) -> Optional[str]:
        return await asyncio.to_thread(self._transcribe_sync, audio_url)

    def _recognize_pcm_chunk(self, chunk_path: str) -> Optional[str]:
        """Recognize a single short PCM chunk via Recognition (with timeout).

        Each chunk is <= realtime_max_seconds, so the real-time API handles
        it without hanging. The forced-stop timer is a belt-and-suspenders
        guard against rare WebSocket stalls.
        """
        try:
            recognizer = Recognition(
                model=self.model,
                callback=None,
                format="pcm",
                sample_rate=16000,
            )
            result = self._recognize_with_timeout(recognizer, chunk_path)
            if result is None:
                logger.warning(f"ASR 块识别超时或无结果: {os.path.basename(chunk_path)}")
                return None
            if getattr(result, "status_code", None) != HTTPStatus.OK:
                logger.warning(
                    f"ASR 块识别非 200: status={getattr(result, 'status_code', None)}, "
                    f"code={getattr(result, 'code', None)}, msg={getattr(result, 'message', None)}"
                )
                return None
            sentences = result.get_sentence() or []
            if isinstance(sentences, dict):
                sentences = [sentences]
            texts = [
                s.get("text", "")
                for s in sentences
                if isinstance(s, dict) and s.get("text")
            ]
            return "\n".join(texts).strip() if texts else None
        except Exception as e:
            logger.warning(f"ASR 块识别异常: {e}")
            return None

    def _transcribe_local_chunked(self, file_path: str) -> Optional[str]:
        """Transcribe a long local file by splitting into timed PCM chunks.

        The real-time Recognition API hangs on multi-minute files (its
        WebSocket duplex stream stalls with no timeout). We transcode to
        PCM once, split into <= realtime_max_seconds chunks, and recognize
        each chunk separately, concatenating the results. A failed chunk
        is skipped rather than failing the whole file.
        """
        self._configure()
        if not os.path.exists(file_path):
            logger.warning(f"ASR 本地文件不存在: {file_path}")
            return None

        t0 = time.time()
        pcm_path = self._transcode_audio_to_pcm(file_path)
        if not pcm_path or not os.path.exists(pcm_path):
            logger.warning("ASR 长音频转码 PCM 失败")
            return None

        try:
            pcm_size = os.path.getsize(pcm_path)
            bytes_per_sec = 16000 * 2  # 16kHz, 16-bit mono
            chunk_bytes = self.realtime_max_seconds * bytes_per_sec
            total_chunks = (pcm_size + chunk_bytes - 1) // chunk_bytes
            duration = pcm_size / bytes_per_sec
            logger.info(
                f"[ASR_PERF] 长音频切块: 时长={duration:.0f}s, "
                f"块数={total_chunks}, 块大小={self.realtime_max_seconds}s"
            )

            texts: list[str] = []
            chunk_idx = 0
            with open(pcm_path, "rb") as f:
                while True:
                    chunk_data = f.read(chunk_bytes)
                    if not chunk_data:
                        break
                    chunk_idx += 1
                    chunk_file = f"{pcm_path}.chunk{chunk_idx}"
                    with open(chunk_file, "wb") as cf:
                        cf.write(chunk_data)
                    try:
                        tc = time.time()
                        text = self._recognize_pcm_chunk(chunk_file)
                        tc2 = time.time()
                        if text:
                            texts.append(text)
                            logger.info(
                                f"[ASR_PERF] 块 {chunk_idx}/{total_chunks} 完成: "
                                f"耗时={tc2-tc:.1f}s, 长度={len(text)}"
                            )
                        else:
                            logger.warning(
                                f"[ASR_PERF] 块 {chunk_idx}/{total_chunks} 无文本, "
                                f"耗时={tc2-tc:.1f}s"
                            )
                    finally:
                        try:
                            os.remove(chunk_file)
                        except Exception:
                            pass

            text = "\n".join(texts).strip()
            t1 = time.time()
            logger.info(
                f"[ASR_PERF] 长音频切块识别完成: 总耗时={t1-t0:.1f}s, "
                f"成功块={len(texts)}/{total_chunks}, 总长度={len(text)}"
            )
            return text if text else None
        finally:
            # Clean up the transcoded PCM (the original file is managed by
            # the caller, asr_page_service, which deletes it in its finally).
            try:
                if pcm_path and os.path.exists(pcm_path):
                    os.remove(pcm_path)
            except Exception:
                logger.debug(f"ASR PCM 清理失败: {pcm_path}")

    def _transcribe_local_via_transcription(self, file_path: str) -> Optional[str]:
        """Upload local file to DashScope OSS and run async Transcription.

        One-shot path for long audio — avoids Recognition WebSocket stalls
        and the N×serial cost of PCM chunk Recognition.
        """
        if not os.path.exists(file_path):
            logger.warning(f"ASR 本地文件不存在: {file_path}")
            return None
        oss_url = self._upload_temp_file(file_path, model=self.transcription_model)
        if not oss_url:
            return None
        logger.info(
            f"[ASR] 长音频走 Transcription model={self.transcription_model}"
        )
        return self._transcribe_sync_with_model(oss_url, self.transcription_model)

    async def transcribe_local_file(self, file_path: str) -> Optional[str]:
        """Transcribe a local audio file, routing by duration.

        Short audio (<= realtime_max_seconds): sync Recognition (single call).
        Long audio / unknown duration:
          1) async Transcription via OSS upload (fast, no hang)
          2) fallback: timed PCM chunk Recognition with hard per-chunk timeout
        """
        duration = self._probe_duration(file_path)
        if duration is not None:
            logger.info(
                f"[ASR] 本地文件时长={duration:.1f}s, 阈值={self.realtime_max_seconds}s"
            )
            if duration <= self.realtime_max_seconds:
                return await asyncio.to_thread(self._recognize_local_file, file_path)
        else:
            logger.warning(
                "[ASR] ffprobe 探测时长失败，按长音频处理（避免 Recognition 挂死）"
            )

        text = await asyncio.to_thread(
            self._transcribe_local_via_transcription, file_path
        )
        if text:
            return text
        logger.warning(
            "[ASR] Transcription 失败，回退到 PCM 切块 Recognition"
        )
        return await asyncio.to_thread(self._transcribe_local_chunked, file_path)


    def _transcribe_sync_with_model(self, audio_url: str, model: str) -> Optional[str]:
        """使用指定模型转写（用于本地文件上传）"""
        if audio_url.startswith("oss://"):
            return self._transcribe_sync_restful(audio_url, model)
        original_model = self.model
        try:
            self.model = model
            return self._transcribe_sync(audio_url)
        finally:
            self.model = original_model
