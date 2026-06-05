#!/usr/bin/env python3
"""
FlakeLocator Pro - Automated Substrate Flake Coordinate & Sizing Engine

A command-line script leveraging OpenCV, NumPy, and Pandas to automate
the localization, oriented bounding, and physical dimension calculation
of 2D flakes from microscopic images, tailored for maskless photolithography.
"""

import os
import sys
import argparse
import cv2
import numpy as np
import pandas as pd



# Calibration state variables
origin_px = (0, 0)
origin_set = False
scale_ratio = 1.0 # px / um
scale_line_start = None
scale_line_end = None
drawing_scale = False
temp_img = None
calib_window_name = "Calibration: Double-Click Origin | Drag Scale Line | Enter to Finish"
pending_scale_dist_px = None  # Set by mouse callback; consumed by run_calibration loop

def calib_mouse_callback(event, x, y, flags, param):
    global origin_px, origin_set, scale_line_start, scale_line_end, drawing_scale, temp_img, pending_scale_dist_px
    
    img_disp = temp_img.copy()
    h, w = img_disp.shape[:2]
    
    # 1. Double Click sets Origin (0,0)
    if event == cv2.EVENT_LBUTTONDBLCLK:
        origin_px = (x, y)
        origin_set = True
        print(f"[Calibration] Origin (0,0) set at pixel coordinates: ({x}, {y})")
        
    # 2. Left click down starts Scale line
    elif event == cv2.EVENT_LBUTTONDOWN:
        scale_line_start = (x, y)
        drawing_scale = True
        
    # 3. Mouse move draws guidance line
    elif event == cv2.EVENT_MOUSEMOVE and drawing_scale:
        scale_line_end = (x, y)
        
    # 4. Left click up ends Scale line
    elif event == cv2.EVENT_LBUTTONUP and drawing_scale:
        scale_line_end = (x, y)
        drawing_scale = False
        dx = scale_line_end[0] - scale_line_start[0]
        dy = scale_line_end[1] - scale_line_start[1]
        dist_px = np.sqrt(dx**2 + dy**2)
        print(f"[Calibration] Drawn scale line length: {dist_px:.2f} pixels.")
        # Bug fix #3 & #4: guard against zero-length drag and move input() out of
        # the mouse callback to avoid blocking the OpenCV GUI event loop.
        if dist_px > 5:
            pending_scale_dist_px = dist_px
        else:
            print("[Calibration] Line too short — please drag a longer line to calibrate.")
            scale_line_start = None
            scale_line_end = None
            
    # Redraw guides
    if origin_set:
        cv2.circle(img_disp, origin_px, 15, (212, 182, 6), 3) # Cyan Circle (BGR)
        cv2.line(img_disp, (origin_px[0]-30, origin_px[1]), (origin_px[0]+30, origin_px[1]), (212, 182, 6), 1)
        cv2.line(img_disp, (origin_px[0], origin_px[1]-30), (origin_px[0], origin_px[1]+30), (212, 182, 6), 1)
        cv2.putText(img_disp, "ORIGIN (0,0)", (origin_px[0]+20, origin_px[1]-10), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (212, 182, 6), 2)
                    
    if scale_line_start and scale_line_end:
        cv2.line(img_disp, scale_line_start, scale_line_end, (129, 185, 16), 3) # Green line
        cv2.circle(img_disp, scale_line_start, 4, (129, 185, 16), -1)
        cv2.circle(img_disp, scale_line_end, 4, (129, 185, 16), -1)
        dx = scale_line_end[0] - scale_line_start[0]
        dy = scale_line_end[1] - scale_line_start[1]
        dist_px = np.sqrt(dx**2 + dy**2)
        cv2.putText(img_disp, f"{dist_px:.1f} px", (scale_line_end[0]+10, scale_line_end[1]+10), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (129, 185, 16), 2)
                    
    # Display UI guides text
    cv2.putText(img_disp, "Double-Click: Set Origin | Drag Line: Calibrate Scale", (20, 30), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    cv2.putText(img_disp, "Press [ENTER] or [q] in this window to complete calibration", (20, 60), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 165, 255), 2)
                
    cv2.imshow(calib_window_name, img_disp)

def run_calibration(img):
    global temp_img, origin_px, pending_scale_dist_px, scale_ratio, scale_line_start, scale_line_end
    temp_img = img.copy()

    # Preset default origin to image center
    h, w = img.shape[:2]
    origin_px = (w // 2, h // 2)

    cv2.namedWindow(calib_window_name, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(calib_window_name, 1200, 800)
    cv2.setMouseCallback(calib_window_name, calib_mouse_callback)

    # Trigger mouse callback once to render default text
    calib_mouse_callback(cv2.EVENT_MOUSEMOVE, 0, 0, 0, None)

    while True:
        key = cv2.waitKey(20) & 0xFF
        if key == 13 or key == ord('q'): # Enter or Q
            break

        # Bug fix #4: handle scale input here (outside callback) so the GUI never freezes.
        if pending_scale_dist_px is not None:
            dist_px = pending_scale_dist_px
            pending_scale_dist_px = None
            val_str = input(f"Enter the real physical distance for these {dist_px:.1f} pixels in micrometers (µm): ")
            try:
                val_um = float(val_str)
                if val_um > 0:
                    scale_ratio = dist_px / val_um
                    print(f"[Calibration] Scale set: {scale_ratio:.4f} pixels/µm")
                else:
                    print("[Calibration] Distance must be positive. Drag the line again to retry.")
                    scale_line_start = None
                    scale_line_end = None
            except ValueError:
                print("[Calibration] Invalid entry. Drag the line again to retry.")
                scale_line_start = None
                scale_line_end = None
            # Refresh the calibration window display
            calib_mouse_callback(cv2.EVENT_MOUSEMOVE, 0, 0, 0, None)

    cv2.destroyWindow(calib_window_name)

def analyze_flakes(img, thresh_val, min_area, max_area, y_axis_inverted=True,
                   color_mode='grayscale', color_sensitivity=30):
    """
    Detect and measure flakes in a microscopy image.

    color_mode:
        'grayscale'  — original luminance threshold (THRESH_BINARY_INV).
                       Works best for yellow/golden flakes on dark SiO2 substrates.
        'color-dist' — per-pixel RGB Euclidean distance from auto-sampled substrate
                       background.  Works for any flake color (blue, green, violet, etc.).
    color_sensitivity:
        Minimum RGB distance from the background to count a pixel as a flake (color-dist mode).
    """
    h, w = img.shape[:2]

    # 1. Image preprocessing
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    if color_mode == 'color-dist':
        # Auto-sample the substrate background from a thin border strip around the image.
        border = max(10, min(h, w) // 20)
        border_mask = np.zeros((h, w), dtype=bool)
        border_mask[:border, :] = True
        border_mask[-border:, :] = True
        border_mask[:, :border] = True
        border_mask[:, -border:] = True
        bg_pixels = img[border_mask]                         # shape (N, 3) in BGR
        bg_color = np.median(bg_pixels, axis=0).astype(np.float32)  # robust median

        # Per-pixel RGB distance from background
        img_f = img.astype(np.float32)
        diff = img_f - bg_color
        color_dist_map = np.sqrt(np.sum(diff ** 2, axis=2))

        # Pixels whose color differs enough from the background are potential flakes
        binary_raw = (color_dist_map >= color_sensitivity).astype(np.uint8) * 255

        # Blur artefacts: apply a small open to remove isolated noise pixels
        binary = binary_raw
    else:
        # Thresholding to binary (fixed slider threshold, inverted for bright-on-dark)
        _, binary = cv2.threshold(blurred, thresh_val, 255, cv2.THRESH_BINARY_INV)

    # Morphological cleaning to strip dust noise
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary_cleaned = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel, iterations=1)
    binary_cleaned = cv2.morphologyEx(binary_cleaned, cv2.MORPH_CLOSE, kernel, iterations=1)
    
    # 2. Extract boundaries
    contours, _ = cv2.findContours(binary_cleaned, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    flake_records = []
    output_overlay = img.copy()
    
    flake_idx = 1
    for i, cnt in enumerate(contours):
        area_px = cv2.contourArea(cnt)
        if min_area <= area_px <= max_area:
            # Centroid calculations
            M = cv2.moments(cnt)
            if M["m00"] < 0.1:
                continue
            cx = M["m10"] / M["m00"]
            cy = M["m01"] / M["m00"]
            
            # Oriented Bounding Box using Rotating Calipers minAreaRect
            rect = cv2.minAreaRect(cnt)
            box = cv2.boxPoints(rect)
            box = np.int32(box)
            
            # Dimensions extraction
            (x_c, y_c), (width_px, length_px), angle = rect
            
            # Physical metrics conversion
            width_um = min(width_px, length_px) / scale_ratio
            length_um = max(width_px, length_px) / scale_ratio
            area_um = area_px / (scale_ratio**2)
            aspect_ratio = length_um / width_um
            
            # Relative physical coordinates relative to calibrated origin
            dx = (cx - origin_px[0]) / scale_ratio
            dy = (cy - origin_px[1]) / scale_ratio
            
            x_um = dx
            y_um = -dy if y_axis_inverted else dy # Standard Cartesian Y increases up
            
            # Save metrics
            flake_records.append({
                "FlakeID": f"flake_{flake_idx:03d}",
                "Name": f"{flake_idx}",
                "Centroid_X_um": round(x_um, 3),
                "Centroid_Y_um": round(y_um, 3),
                "Length_um": round(length_um, 2),
                "Width_um": round(width_um, 2),
                "AspectRatio": round(aspect_ratio, 2),
                "Area_um2": round(area_um, 1),
                "Orientation_deg": round(angle, 1)
            })
            
            # Draw boundary shape contours on diagnostic image
            color = (129, 185, 16) # Emerald Green (BGR)
            cv2.drawContours(output_overlay, [box], 0, (0, 255, 255), 1) # Yellow Oriented Box
            cv2.drawContours(output_overlay, [cnt], -1, color, 2) # Green Contour
            
            # Centroid mark
            cv2.circle(output_overlay, (int(cx), int(cy)), 4, (0, 0, 255), -1)
            
            # Label index
            cv2.putText(output_overlay, f"#{flake_idx}", (int(cx)+8, int(cy)-8), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 2)
            
            flake_idx += 1
            
    return flake_records, output_overlay, binary_cleaned

def launch_web_server(port=8123):
    import socket
    import webbrowser
    import time
    import threading
    import http.server
    import socketserver

    # Bug fix #5: serve from the script's own directory so index.html / app.js / style.css
    # are found regardless of where the user invokes the script from.
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    # 1. Check if the server is already running on the target port
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.5)
    already_running = False
    try:
        s.connect(("127.0.0.1", port))
        already_running = True
        s.close()
    except OSError:
        pass

    if already_running:
        url = f"http://localhost:{port}"
        print(f"\n[Web Host] Server is already running on port {port}.")
        print(f"Launching default web browser to: {url}\n")
        webbrowser.open(url)
        return

    # 2. If not running, start the server and open the browser
    actual_port = port
    server = None
    while actual_port < port + 10:
        try:
            handler = http.server.SimpleHTTPRequestHandler
            server = socketserver.TCPServer(("", actual_port), handler)
            break
        except OSError:
            actual_port += 1

    if not server:
        print("Error: Could not bind to any local port in range 8123-8132.")
        sys.exit(1)

    def open_browser():
        time.sleep(0.5)
        url = f"http://localhost:{actual_port}"
        print(f"Launching default web browser to: {url}")
        webbrowser.open(url)

    threading.Thread(target=open_browser, daemon=True).start()
    
    print(f"\n[Web Host] Starting local server at http://localhost:{actual_port}")
    print("Press Ctrl+C to stop the server.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nWeb host server stopped.")
        sys.exit(0)

def main():
    parser = argparse.ArgumentParser(description="FlakeLocator Pro micro-imaging automation engine.")
    parser.add_argument("image_path", nargs="?", default=None, help="Path to substrate microscopic image (e.g. IMG_0327.jpeg)")
    parser.add_argument("--thresh", type=int, default=120, help="Initial contrast threshold (0-255)")
    parser.add_argument("--min-area", type=int, default=100, help="Minimum flake size in pixels")
    parser.add_argument("--max-area", type=int, default=500000, help="Maximum flake size in pixels")
    parser.add_argument("--axis-y", choices=["cartesian", "image"], default="cartesian",
                        help="Y-axis coordinate convention (Cartesian: Y increases upwards)")
    parser.add_argument("--color-mode", choices=["grayscale", "color-dist"], default="grayscale",
                        help="Detection strategy: 'grayscale' (default, best for yellow/golden flakes) "
                             "or 'color-dist' (RGB distance from substrate — detects any flake color)")
    parser.add_argument("--color-sensitivity", type=int, default=30,
                        help="Minimum RGB distance from background to count as a flake (color-dist mode, default: 30)")


    
    args = parser.parse_args()
    
    if args.image_path is None:
        launch_web_server()
        return
        
    if not os.path.exists(args.image_path):
        print(f"Error: Target image file not found at '{args.image_path}'")
        sys.exit(1)
        
    print(f"Reading target image: {args.image_path}")
    img = cv2.imread(args.image_path)
    if img is None:
        print("Error: Could not decode target microscopic image.")
        sys.exit(1)
        
    h, w = img.shape[:2]
    print(f"Loaded image resolution: {w} x {h} pixels.")
    
    # 1. Run interactive calibration window
    print("\n--- Calibration Phase ---")
    print("1. Double click anywhere to set the substrate ORIGIN (0,0).")
    print("2. Left-click & drag a line directly over your microscopic scale bar to calibrate px/µm.")
    print("3. When complete, click inside the calibration window and press 'ENTER' or 'q'.\n")
    run_calibration(img)
    
    print("\nCalibration finished.")
    print(f"Current pixels/µm ratio: {scale_ratio:.4f}")
    print(f"Substrate Origin (0,0) pixels coordinate: {origin_px}")
    
    y_axis_inverted = (args.axis_y == "cartesian")
    records = []
    overlay = None

    print(f"\nDetection method : threshold  "
          f"(color_mode={args.color_mode}"
          + (f", sensitivity={args.color_sensitivity}" if args.color_mode == 'color-dist' else "")
          + ")")

    slider_window_name = "Adjust Parameters & Press ENTER"
    cv2.namedWindow(slider_window_name, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(slider_window_name, 1200, 800)

    cv2.createTrackbar("Threshold", slider_window_name, args.thresh, 255, lambda x: None)
    cv2.createTrackbar("Min Area",  slider_window_name, args.min_area, 10000, lambda x: None)

    print("\n--- Fine-tuning Segmentation ---")
    print("Adjust the sliders in the window to perfectly isolate your flakes.")
    print("Press [ENTER] or [q] when done to write data and generate CSV reports.")

    while True:
        th    = cv2.getTrackbarPos("Threshold", slider_window_name)
        min_a = cv2.getTrackbarPos("Min Area",  slider_window_name)

        records, overlay, binary_mask = analyze_flakes(
            img, th, min_a, args.max_area, y_axis_inverted,
            color_mode=args.color_mode, color_sensitivity=args.color_sensitivity
        )

        mask_3ch = cv2.cvtColor(binary_mask, cv2.COLOR_GRAY2BGR)
        combined = np.hstack((overlay, mask_3ch))
        cv2.putText(combined,
                    f"Detected Flakes: {len(records)} | Threshold: {th} | Min Area: {min_a}",
                    (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
        cv2.imshow(slider_window_name, combined)

        key = cv2.waitKey(50) & 0xFF
        if key == 13 or key == ord('q'):
            break

    cv2.destroyAllWindows()
    
    # 3. Export data & summary report
    if len(records) == 0:
        print("\nNo flakes matched the filter sizes. No data was exported.")
        sys.exit(0)
        
    df = pd.DataFrame(records)
    
    # Export CSV matching lithography stages format
    base_name = os.path.splitext(args.image_path)[0]
    csv_path = f"{base_name}_FlakeMetrics.csv"
    df.to_csv(csv_path, index=False)
    print(f"\n[Export] Lithography coordinate spreadsheet written to: {csv_path}")
    
    # Export Diagnostic visual overlay image
    overlay_path = f"{base_name}_detected.png"
    cv2.imwrite(overlay_path, overlay)
    print(f"[Export] Sizing boundary visual overlay image written to: {overlay_path}")
    
    print("\n--- Sizing Succeeded ---")
    print(df.to_string(index=False))

if __name__ == "__main__":
    main()
