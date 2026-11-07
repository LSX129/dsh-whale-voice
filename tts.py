"""鲸语 · edge-tts 合成 worker。

从 stdin 读一个 UTF-8 JSON 请求，合成 mp3 到指定路径，向 stdout 输出一行 JSON 结果。

请求字段：
  pylibs  edge-tts 依赖所在目录（可空，空则只用当前 sys.path）
  text    要朗读的文本
  voice   edge-tts 音色名
  rate    语速，如 "+8%"
  pitch   音调，如 "+18Hz"
  out     输出 mp3 绝对路径
"""

import asyncio
import json
import os
import sys


def _fail(message):
    """输出失败结果并以 1 退出。"""
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    sys.stdout.flush()
    os._exit(1)


def main():
    """读取请求、合成音频、报告结果。"""
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    try:
        request = json.loads(sys.stdin.read() or "{}")
    except Exception as error:
        _fail("bad request json: %s" % error)

    pylibs = request.get("pylibs") or ""
    if pylibs and os.path.isdir(pylibs):
        sys.path.insert(0, pylibs)

    try:
        import edge_tts
    except Exception as error:
        _fail(
            "import edge_tts failed: %s: %s（先在插件目录运行 npm run setup，"
            "或 pip install --target pylibs edge-tts）" % (type(error).__name__, error)
        )

    text = request.get("text") or ""
    if not text.strip():
        _fail("empty text")

    out = request.get("out") or ""
    if not out:
        _fail("missing out path")

    voice = request.get("voice") or "zh-CN-XiaoyiNeural"
    rate = request.get("rate") or "+0%"
    pitch = request.get("pitch") or "+0Hz"

    async def run():
        """执行一次合成。"""
        communicator = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
        await communicator.save(out)

    try:
        asyncio.run(run())
    except Exception as error:
        _fail("%s: %s" % (type(error).__name__, error))

    if not os.path.exists(out) or os.path.getsize(out) == 0:
        _fail("no audio written")

    print(json.dumps({"ok": True, "bytes": os.path.getsize(out)}, ensure_ascii=False))
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
