"""Deterministic protocol fixture only: no model, no generative quality claim."""
import base64
import json
import struct
import sys
import time
import zlib

request = json.load(sys.stdin)
if request["prompt"] == "wait":
    time.sleep(30)


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)


w, h = request["width"], request["height"]
image = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
image += chunk(b"IDAT", zlib.compress((b"\0" + b"\x12\x22\x42" * w) * h)) + chunk(b"IEND", b"")
print(json.dumps({"mimeType": "image/png", "base64": base64.b64encode(image).decode("ascii")}))
