# test_networking.py
import http.server
import socketserver
import os
import sys
import http.client

# Define a simple, predictable path for the output file in the user's home directory.
try:
    home_dir = os.path.expanduser("~")
    output_file_path = os.path.join(home_dir, "davinci_networking_test.txt")
except Exception as e:
    # Use print for Davinci console, as file I/O might fail.
    print(f"NET TEST: Could not determine home directory: {e}")
    sys.exit(1)

def write_to_file(message):
    """Helper function to write test results to a file."""
    try:
        # Open in append mode to add lines sequentially.
        with open(output_file_path, "a") as f:
            f.write(f"{message}\n")
        print(f"NET TEST: Logged to file: '{message}'")
    except Exception as e:
        print(f"NET TEST: CRITICAL ERROR writing to file: {e}")

# --- Main script execution starts here ---

# Clean up previous test file if it exists
if os.path.exists(output_file_path):
    os.remove(output_file_path)

print("--- NETWORKING TEST STARTED ---")
print(f"This script will write results to: {output_file_path}")
write_to_file("--- NETWORKING TEST STARTED ---")

# --- Test 1: Attempt to create and bind an HTTP Server on the main thread ---
PORT = 8999
server_initialized = False
try:
    print(f"NET TEST: Attempting to initialize TCPServer on port {PORT}...")
    # This is the line that likely fails in the DaVinci environment.
    httpd = socketserver.TCPServer(("", PORT), http.server.SimpleHTTPRequestHandler)
    print("NET TEST: TCPServer initialized successfully.")
    write_to_file(f"SUCCESS: TCPServer initialization on port {PORT} worked.")
    server_initialized = True
    
    # We don't need to run it, just close it immediately.
    print("NET TEST: Closing the server immediately.")
    httpd.server_close()
    write_to_file("INFO: Server closed.")

except Exception as e:
    print(f"NET TEST: FAILED to initialize TCPServer. Error: {e}")
    write_to_file(f"FAILURE: Could not initialize TCPServer. Error: {e}")

# --- Test 2: Attempt to make an outbound HTTP request ---
print("\n---")
print("NET TEST: Attempting an outbound HTTP GET request to example.com...")
try:
    # Using http.client for minimal dependencies.
    conn = http.client.HTTPSConnection("example.com", timeout=10)
    conn.request("GET", "/")
    response = conn.getresponse()
    print(f"NET TEST: Received response. Status: {response.status}, Reason: {response.reason}")
    
    if response.status == 200:
        write_to_file("SUCCESS: Outbound HTTPS request to example.com succeeded.")
    else:
        write_to_file(f"FAILURE: Outbound HTTPS request failed with status {response.status}.")
    conn.close()

except Exception as e:
    print(f"NET TEST: FAILED to make outbound HTTP request. Error: {e}")
    write_to_file(f"FAILURE: Outbound HTTPS request failed. Error: {e}")

print("\n--- NETWORKING TEST FINISHED ---")
write_to_file("--- NETWORKING TEST FINISHED ---")
