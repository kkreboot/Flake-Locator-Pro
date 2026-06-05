# 🔬 FlakeLocator Pro

**Automated substrate flake detection, coordinate extraction, and sizing for maskless photolithography.**

FlakeLocator Pro detects 2D material flakes in microscopy images, measures their physical dimensions, and exports stage-ready coordinates — all calibrated to real-world micrometre units.

---

## Features

- **Interactive calibration** — set a coordinate origin and drag a scale bar to establish px/µm ratio
- **Two detection modes**
  - `grayscale` — luminance threshold, optimised for golden/yellow flakes on SiO₂
  - `color-dist` — RGB Euclidean distance from auto-sampled substrate background; works for any flake colour
- **Live parameter tuning** — OpenCV trackbar sliders for threshold and minimum area
- **Oriented bounding boxes** — `minAreaRect` gives true length, width, and orientation angle
- **CSV export** — centroid coordinates, length, width, aspect ratio, area, and orientation per flake
- **Diagnostic overlay** — annotated PNG showing detected contours and labelled centroids
- **Web UI** — browser-based interface (no Python required for viewing results); launch with `python flake_analyzer.py`

---

## Requirements

- Python ≥ 3.9
- Dependencies listed in `requirements.txt`:

```
numpy>=1.22.0
opencv-python>=4.6.0
pandas>=1.4.0
scikit-learn>=1.2.0
```

---

## Installation

```bash
git clone https://github.com/<your-username>/flake-locator-pro.git
cd flake-locator-pro
pip install -r requirements.txt
```

---

## Usage

### Web UI (browser-based)

```bash
python flake_analyzer.py
```

Opens `http://localhost:8123` in your default browser. Upload an image, calibrate interactively, and export results — no additional arguments needed.

### Command-line

```bash
python flake_analyzer.py <image_path> [options]
```

| Argument | Default | Description |
|---|---|---|
| `image_path` | — | Path to microscopy image (JPEG, PNG, etc.) |
| `--thresh` | `120` | Initial contrast threshold (0–255) |
| `--min-area` | `100` | Minimum flake area in pixels |
| `--max-area` | `500000` | Maximum flake area in pixels |
| `--axis-y` | `cartesian` | Y-axis convention: `cartesian` (up = positive) or `image` (down = positive) |
| `--color-mode` | `grayscale` | Detection strategy: `grayscale` or `color-dist` |
| `--color-sensitivity` | `30` | Min RGB distance from substrate to count as flake (`color-dist` only) |

#### Example

```bash
# Standard run with grayscale threshold
python flake_analyzer.py IMG_0327.jpeg --thresh 130 --min-area 200

# Color-distance mode for non-golden flakes
python flake_analyzer.py sample.png --color-mode color-dist --color-sensitivity 25
```

### Calibration workflow

1. **Double-click** anywhere in the calibration window to set the substrate origin (0, 0).
2. **Click and drag** a line along the image scale bar.
3. Enter the physical length of that line in µm when prompted.
4. Press `Enter` or `q` to finish calibration.

---

## Output files

For an input `IMG_0327.jpeg` the script produces:

| File | Contents |
|---|---|
| `IMG_0327_FlakeMetrics.csv` | Per-flake coordinates, dimensions, orientation |
| `IMG_0327_detected.png` | Annotated overlay image |

### CSV columns

| Column | Unit | Description |
|---|---|---|
| `FlakeID` | — | Unique identifier (`flake_001`, …) |
| `Centroid_X_um` | µm | X coordinate relative to calibrated origin |
| `Centroid_Y_um` | µm | Y coordinate relative to calibrated origin |
| `Length_um` | µm | Long axis of oriented bounding box |
| `Width_um` | µm | Short axis of oriented bounding box |
| `AspectRatio` | — | Length / Width |
| `Area_um2` | µm² | Contour area |
| `Orientation_deg` | ° | Bounding box rotation angle |

---

## Project structure

```
flake-locator-pro/
├── flake_analyzer.py   # Core detection engine + CLI + web server launcher
├── index.html          # Web UI
├── app.js              # Web UI logic
├── style.css           # Web UI styles
└── requirements.txt    # Python dependencies
```

---

## License

MIT — see [LICENSE](LICENSE) for details.
