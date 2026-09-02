#!/usr/bin/env python3
"""
lan-mirror.py — ทางสำรองแบบ MJPEG สำหรับส่งจอโน้ตบุ๊กขึ้นจอ Tesla

ใช้เมื่อเบราว์เซอร์ในรถรับ WebRTC ไม่ได้ (หน้า /screen/ ขึ้นเขียวไม่ครบ)
สคริปต์นี้แคปจอเองแล้วเสิร์ฟเป็น MJPEG ผ่าน HTTP ธรรมดาในวง LAN
เบราว์เซอร์รุ่นไหนก็เปิดได้ ขอแค่แสดง <img> เป็น

    pip install mss pillow
    python3 tools/lan-mirror.py

แล้วเปิด URL ที่สคริปต์พิมพ์ออกมาในเบราว์เซอร์ของรถ

ข้อแลกเปลี่ยน: MJPEG ไม่บีบอัดข้ามเฟรม กินแบนด์วิดท์กว่า WebRTC มาก
จึงควรใช้ในวง Wi-Fi เดียวกันเท่านั้น และเซิร์ฟเวอร์นี้ไม่มีการเข้ารหัส/
ยืนยันตัวตน — เปิดเฉพาะบนเครือข่ายที่ไว้ใจได้
"""

import argparse
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

try:
    import mss
    from PIL import Image
except ImportError:
    sys.exit("ต้องติดตั้งก่อน:  pip install mss pillow")


PAGE = b"""<!DOCTYPE html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>LAN Mirror</title>
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden}
  img{width:100%;height:100%;object-fit:contain;display:block}
</style></head>
<body><img src="/stream.mjpg" alt=""></body></html>
"""

BOUNDARY = b"--frameboundary"

ARGS = None


def lan_ip():
    """หา IP ในวง LAN ที่เครื่องนี้ใช้ออกเน็ตจริง"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *a):  # เงียบไว้ ไม่งั้นรกจอ
        pass

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(PAGE)))
            self.end_headers()
            self.wfile.write(PAGE)
        elif self.path.startswith("/stream.mjpg"):
            self.stream()
        else:
            self.send_error(404)

    def stream(self):
        self.send_response(200)
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header(
            "Content-Type", "multipart/x-mixed-replace; boundary=frameboundary"
        )
        self.end_headers()

        interval = 1.0 / ARGS.fps
        # mss ไม่ thread-safe — สร้างใหม่ต่อหนึ่ง connection
        with mss.mss() as sct:
            monitors = sct.monitors
            idx = ARGS.monitor
            if idx >= len(monitors):
                idx = 0 if len(monitors) < 2 else 1
            mon = monitors[idx]
            try:
                while True:
                    start = time.time()
                    shot = sct.grab(mon)
                    img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
                    if ARGS.width and img.width > ARGS.width:
                        h = round(img.height * ARGS.width / img.width)
                        img = img.resize((ARGS.width, h), Image.BILINEAR)
                    buf = BytesIO()
                    img.save(buf, "JPEG", quality=ARGS.quality, subsampling=0)
                    data = buf.getvalue()

                    self.wfile.write(BOUNDARY + b"\r\n")
                    self.wfile.write(b"Content-Type: image/jpeg\r\n")
                    self.wfile.write(
                        b"Content-Length: " + str(len(data)).encode() + b"\r\n\r\n"
                    )
                    self.wfile.write(data)
                    self.wfile.write(b"\r\n")

                    lag = interval - (time.time() - start)
                    if lag > 0:
                        time.sleep(lag)
            except (BrokenPipeError, ConnectionResetError):
                pass  # ผู้ชมปิดหน้าไปเอง


def main():
    global ARGS
    p = argparse.ArgumentParser(description="ส่งจอโน้ตบุ๊กขึ้นจอ Tesla ผ่าน MJPEG ในวง LAN")
    p.add_argument("--port", type=int, default=8080, help="พอร์ต (ค่าเริ่มต้น 8080)")
    p.add_argument("--fps", type=float, default=10, help="เฟรมต่อวินาที (ค่าเริ่มต้น 10)")
    p.add_argument("--quality", type=int, default=70, help="คุณภาพ JPEG 1-95 (ค่าเริ่มต้น 70)")
    p.add_argument("--width", type=int, default=1600, help="ย่อภาพให้กว้างไม่เกินกี่ px (0 = ไม่ย่อ)")
    p.add_argument(
        "--monitor",
        type=int,
        default=1,
        help="จอที่จะส่ง: 1 = จอหลัก, 2 = จอที่สอง/จอเสมือน, 0 = ทุกจอรวมกัน",
    )
    ARGS = p.parse_args()

    ip = lan_ip()
    srv = ThreadingHTTPServer(("0.0.0.0", ARGS.port), Handler)
    print("")
    print("  พร้อมแล้ว — เปิด URL นี้ในเบราว์เซอร์ของรถ:")
    print("")
    print("      http://%s:%d/" % (ip, ARGS.port))
    print("")
    print("  %.0f fps · JPEG q%d · กว้างไม่เกิน %s px · จอที่ %d"
          % (ARGS.fps, ARGS.quality, ARGS.width or "ไม่จำกัด", ARGS.monitor))
    print("  Ctrl+C เพื่อหยุด")
    print("")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("หยุดแล้ว")
        srv.shutdown()


if __name__ == "__main__":
    main()
