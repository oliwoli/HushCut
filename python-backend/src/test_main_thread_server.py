# test_main_thread_server.py
import http.server
import socketserver
import os
import sys
import http.client
import time
import socket

# Define a simple, predictable path for the output file in the user's home directory.
try:
    home_dir = os.path.expanduser("~")
    output_file_path = os.path.join(home_dir, "davinci_main_thread_server_test.txt")
except Exception as e:
    print(f"MAIN THREAD SERVER TEST: Could not determine home directory: {e}")
    sys.exit(1)

def write_to_file(message):
    """Helper function to write test results to a file."""
    try:
        with open(output_file_path, "a") as f:
            f.write(f"{message}\n")
        print(f"MAIN THREAD SERVER TEST: Logged to file: '{message}'")
    except Exception as e:
        print(f"MAIN THREAD SERVER TEST: CRITICAL ERROR writing to file: {e}")

def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return s.getsockname()[1]

# --- Main script execution starts here ---

# Clean up previous test file if it exists
if os.path.exists(output_file_path):
    os.remove(output_file_path)

print("--- MAIN THREAD SERVER TEST STARTED ---")
print(f"This script will write results to: {output_file_path}")
write_to_file("--- MAIN THREAD SERVER TEST STARTED ---")

PORT = find_free_port() # Dynamically find a free port

# --- Custom Request Handler to log incoming requests ---
class TestRequestHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        write_to_file(f"MAIN THREAD SERVER TEST: [Server] Received GET request for {self.path}")
        self.send_response(200)
        self.send_header("Content-type", "text/html")
        self.end_headers()
        self.wfile.write(b"Hello from Python main thread server!")

    def do_POST(self):
        content_length = int(self.headers['Content-Length'])
        post_body = self.rfile.read(content_length).decode('utf-8')
        write_to_file(f"MAIN THREAD SERVER TEST: [Server] Received POST request for {self.path} with body: {post_body}")
        self.send_response(200)
        self.send_header("Content-type", "text/html")
        self.end_headers()
        self.wfile.write(b"POST received!")

# --- Initialize the HTTP server ---
httpd = None
try:
    write_to_file(f"MAIN THREAD SERVER TEST: Attempting to initialize TCPServer on port {PORT}...")
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), TestRequestHandler)
    write_to_file(f"MAIN THREAD SERVER TEST: TCPServer initialized successfully on port {PORT}.")
except Exception as e:
    write_to_file(f"MAIN THREAD SERVER TEST: FAILURE: Could not initialize TCPServer. Error: {e}")
    print(f"MAIN THREAD SERVER TEST: CRITICAL ERROR: {e}")
    sys.exit(1)

start_time = time.time()
end_time = start_time + 20 # Run for 20 seconds

last_outbound_request_time = 0
outbound_request_interval = 5 # Make an outbound request every 5 seconds

write_to_file("MAIN THREAD SERVER TEST: Entering main loop...")

while time.time() < end_time:
    # Handle one incoming HTTP request (non-blocking if no requests)
    # This will block until a request comes in or a timeout occurs.
    # We don't set a timeout here, as we want it to process any pending requests.
    # The sleep below will ensure we don't busy-wait.
    httpd.handle_request()

    # Simulate other work: make an outbound HTTP request periodically
    if time.time() - last_outbound_request_time > outbound_request_interval:
        write_to_file("MAIN THREAD SERVER TEST: [Main Loop] Making outbound HTTP request...")
        try:
            conn = http.client.HTTPSConnection("api.preview.minepkg.io", timeout=5)
            conn.request("GET", "/v1/projects/modmenu")
            response = conn.getresponse()
            response_body = response.read().decode('utf-8')
            write_to_file(f"MAIN THREAD SERVER TEST: [Main Loop] Outbound request status: {response.status}, body length: {len(response_body)}")
            conn.close()
        except Exception as e:
            write_to_file(f"MAIN THREAD SERVER TEST: [Main Loop] Outbound request FAILED: {e}")
        last_outbound_request_time = time.time()

    # Yield control to DaVinci Resolve's main loop
    time.sleep(0.01)

write_to_file("MAIN THREAD SERVER TEST: Exiting main loop.")

# --- Clean up ---
if httpd:
    write_to_file("MAIN THREAD SERVER TEST: Closing server.")
    httpd.server_close()

write_to_file("--- MAIN THREAD SERVER TEST FINISHED ---")
print("--- MAIN THREAD SERVER TEST FINISHED ---")