import subprocess
import time
import sys
import threading

cmd = ["lua-helper.exe", "--lua-helper", "--port=8080"]

proc = subprocess.Popen(
    cmd,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1
)

print("Started server, logging output... (Ctrl+C to quit)")

def log_reader():
    for line in proc.stdout:
        print("SERVER:", line.strip())

# Run reader in a background thread so Ctrl+C still works
t = threading.Thread(target=log_reader, daemon=True)
t.start()

try:
    while t.is_alive():
        time.sleep(0.2)  # let the thread run, but stay interruptible
except KeyboardInterrupt:
    print("\nStopping server...")
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    sys.exit(0)
