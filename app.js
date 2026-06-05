// FlakeLocator Pro - Core Application Script

// State variables
const state = {
    images: [], // List of loaded substrate images
    activeImageId: null,
    tool: 'pan', // 'pan', 'scale', 'origin', 'box', 'rbox', 'polygon', 'floodfill', 'stitch'
    scaleRatio: 1.0, // pixels per micrometer (px/um)
    scaleDistance: 10, // Default distance in um for calibration
    origin: { x: 0, y: 0 }, // Origin pixel coordinates
    yAxisInverted: true, // true: Y-axis increases upwards (Cartesian), false: Y-axis increases downwards (Image space)
    
    // Zoom & Pan
    zoom: 1.0,
    pan: { x: 0, y: 0 },
    isPanning: false,
    panStart: { x: 0, y: 0 },
    
    // Annotation drawing
    drawingPoints: [],
    rboxStep: 0, // for rotated box clicks (0, 1, 2)
    hoveredFlakeId: null,
    selectedFlakeId: null,
    
    // Ignore areas
    ignoreAreas: [], // List of user-defined ignore bounding boxes: { minX, maxX, minY, maxY }
    selectedIgnoreAreaIndex: null,
    hoveredIgnoreAreaIndex: null,
    resizingIgnoreAreaIndex: null,
    resizeHandle: null, // 'nw', 'ne', 'se', 'sw', 'move'
    
    // Stitch Align dragging variables
    draggingImageId: null,
    stitchStart: { x: 0, y: 0 },
    stitchImageOffset: { x: 0, y: 0 },

    // Matrix grid layout
    gridLayout: {
        enabled: false,
        rows: 3,
        cols: 3,
        gapX: 10,       // horizontal gap between cells in pixels (world space)
        gapY: 10,       // vertical gap between cells in pixels (world space)
        cells: {},      // "row,col" -> imageId
        showLines: true,
    },

    // Image processing filters
    filters: {
        contrast: 1.0, // 0.5 to 2.0
        brightness: 1.0, // 0.5 to 2.0
        threshold: 128, // 0 to 255
        showBinary: false,
        tolerance: 255, // Flood fill color tolerance
        minSize: 100, // Minimum flake size in pixels
        ignoreBanner: true, // Ignore bottom 10% of image height
        showCrosshairs: true, // Show major/minor dimension crosshairs on flakes
        showLabels: false, // Always show text name and dimensions labels on flakes
        colorMode: 'grayscale',        // 'grayscale' | 'colorDist' — detection strategy
        colorDistThreshold: 20,        // min RGB distance from substrate background to count as flake (colorDist mode)
        watershedSplit: false,         // split merged blobs via erosion-flood
        morphCleanup: false,           // morphological noise cleanup before detection
        erosionKernel: 2,              // erosion radius for morphological cleanup
    },

    // Flake list search / sort state
    flakeSearch: '',
    flakeSortKey: 'index',            // 'index' | 'area' | 'length' | 'contrast' | 'tag' | 'name' | 'x_um' | 'y_um' | 'width' | 'ar' | 'orientation'
    flakeSortDir: 1,                  // +1 asc, -1 desc
    tableSortKey: null,
    brushFilter: null,                // { minArea, maxArea, minContrast } set by stats dashboard range filter
    tableSortDir: 1
};

// Canvas elements
let canvas, ctx;
let offscreenCanvas, offscreenCtx;
let loadedImageEl = null;

// -------------------------------------------------------------------------
// Progress bar helpers for auto-detect
// -------------------------------------------------------------------------
function setDetectProgress(pct, text) {
    const wrap = document.getElementById('detect-progress-wrap');
    const bar  = document.getElementById('detect-progress-bar');
    const msg  = document.getElementById('detect-progress-text');
    if (!wrap) return;
    wrap.style.display = 'block';
    if (bar) bar.style.width = `${Math.min(100, pct)}%`;
    if (msg && text) msg.textContent = text;
}
function hideDetectProgress() {
    const wrap = document.getElementById('detect-progress-wrap');
    if (wrap) wrap.style.display = 'none';
}

// -------------------------------------------------------------------------
// Morphological cleanup: 2-pass erosion on the flake mask
// Returns a Uint8Array mask where 1 = kept flake pixel, 0 = eroded away
//
// Bug fix: the original version passed raw pixel values to isFlakePixelFn but
// the main detection loop uses contrast/brightness-adjusted values.  We now
// accept an adjustFn so the mask is built from the same adjusted values.
// -------------------------------------------------------------------------
function buildErodedMask(isFlakePixelFn, adjustFn, rawData, w, h, radius) {
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            const pi  = idx * 4;
            // Apply the same contrast/brightness adjustment as the main scan
            const px = adjustFn(pi);
            mask[idx] = isFlakePixelFn(px.r, px.g, px.b, idx) ? 1 : 0;
        }
    }
    const eroded = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!mask[y * w + x]) continue;
            let ok = true;
            outer: for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    const ny = y + dy, nx = x + dx;
                    if (ny < 0 || ny >= h || nx < 0 || nx >= w || !mask[ny * w + nx]) {
                        ok = false; break outer;
                    }
                }
            }
            if (ok) eroded[y * w + x] = 1;
        }
    }
    return eroded;
}

// -------------------------------------------------------------------------
// Flake list filter / sort
// -------------------------------------------------------------------------
function getFilteredSortedFlakes(flakes) {
    const q = (state.flakeSearch || '').toLowerCase().trim();
    let list = flakes;
    if (q) {
        list = list.filter(f =>
            f.name.toLowerCase().includes(q) ||
            (f.customTag || '').toLowerCase().includes(q) ||
            (f.notes || '').toLowerCase().includes(q)
        );
    }
    // Brush / range filter from stats dashboard
    if (state.brushFilter) {
        const { minArea, maxArea, minContrast } = state.brushFilter;
        list = list.filter(f => {
            if ((f.area || 0) < minArea) return false;
            if (maxArea !== Infinity && (f.area || 0) > maxArea) return false;
            if (minContrast > 0 && (f.relContrast == null || f.relContrast < minContrast)) return false;
            return true;
        });
    }
    const key = state.flakeSortKey;
    const dir = state.flakeSortDir;
    if (key && key !== 'index') {
        list = [...list].sort((a, b) => {
            let va, vb;
            if (key === 'ar') { va = a.length / a.width; vb = b.length / b.width; }
            else if (key === 'tag') { va = (a.customTag || '').toLowerCase(); vb = (b.customTag || '').toLowerCase(); }
            else if (key === 'name') { va = a.name; vb = b.name; }
            // Bug fix: 'contrast' option maps to relContrast field (not a.contrast which is undefined)
            else if (key === 'contrast') { va = a.relContrast ?? 0; vb = b.relContrast ?? 0; }
            else { va = a[key] ?? 0; vb = b[key] ?? 0; }
            if (va < vb) return -dir;
            if (va > vb) return dir;
            return 0;
        });
    }
    return list;
}

function filterFlakeList(query) {
    state.flakeSearch = query;
    renderFlakes();
}

function sortFlakeList(val) {
    // val format: "area_desc", "area_asc", "index", "tag", "length_desc", "contrast_asc"
    // Bug fix: single-token values like "index", "tag" had no '_' separator, so parts[1] was
    // undefined which fell to the else branch and set flakeSortDir = -1 incorrectly.
    const parts = val.split('_');
    if (parts[0] === 'index') {
        state.flakeSortKey = 'index';
        state.flakeSortDir = 1;
    } else if (parts[1] === 'asc') {
        state.flakeSortKey = parts[0];
        state.flakeSortDir = 1;
    } else if (parts[1] === 'desc') {
        state.flakeSortKey = parts[0];
        state.flakeSortDir = -1;
    } else {
        // Single-token values (tag, name, etc.) — always ascending
        state.flakeSortKey = parts[0];
        state.flakeSortDir = 1;
    }
    renderFlakes();
}

function tableSort(key) {
    if (state.tableSortKey === key) {
        state.tableSortDir *= -1;
    } else {
        state.tableSortKey = key;
        state.tableSortDir = 1;
    }
    // Map table column keys to flakeSortKey
    state.flakeSortKey = key;
    state.flakeSortDir = state.tableSortDir;
    // Update arrow indicators
    document.querySelectorAll('.sort-arrow').forEach(el => {
        el.textContent = '⇅';
        el.className = 'sort-arrow';
    });
    const arrow = document.getElementById(`sort-arrow-${key}`);
    if (arrow) {
        arrow.textContent = state.tableSortDir === 1 ? '↑' : '↓';
        arrow.className = `sort-arrow ${state.tableSortDir === 1 ? 'asc' : 'desc'}`;
    }
    renderFlakes();
}
window.filterFlakeList = filterFlakeList;
window.sortFlakeList   = sortFlakeList;
window.tableSort       = tableSort;

// Palette of colors for marking flakes
const COLORS = [
    '#10b981', '#06b6d4', '#f59e0b', '#ec4899', '#8b5cf6',
    '#3b82f6', '#ef4444', '#14b8a6', '#f43f5e', '#a855f7'
];
let colorIndex = 0;

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    canvas = document.getElementById('image-canvas');
    ctx = canvas.getContext('2d');

    offscreenCanvas = document.createElement('canvas');
    offscreenCtx = offscreenCanvas.getContext('2d');

    setupEventListeners();
    setupDefaultImage();
    showToast('FlakeLocator Pro initialized successfully', 'info');

    // ── file:// protocol warning ──────────────────────────────────────────────
    if (window.location.protocol === 'file:') {
        _showFileProtocolBanner();
    }
});

function _showFileProtocolBanner() {
    const banner = document.createElement('div');
    banner.id = 'file-protocol-banner';
    banner.innerHTML = `
        <span>⚠️ <b>Running from file://</b> — browser security blocks pixel access (auto-detect, flood-fill, JPG export will fail).
        Run a local server instead:</span>
        <code style="background:rgba(0,0,0,0.35);padding:0.1rem 0.5rem;border-radius:4px;font-size:0.72rem;margin:0 0.4rem;">
            python -m http.server 8123
        </code>
        <span>then open</span>
        <code style="background:rgba(0,0,0,0.35);padding:0.1rem 0.5rem;border-radius:4px;font-size:0.72rem;margin:0 0.4rem;">
            http://localhost:8123
        </code>
        <button onclick="document.getElementById('file-protocol-banner').remove()"
            style="margin-left:0.75rem;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);color:#fff;border-radius:4px;padding:0.15rem 0.5rem;cursor:pointer;font-size:0.72rem;">
            Dismiss
        </button>`;
    document.body.appendChild(banner);
}

// Load standard placeholder or initial image
function setupDefaultImage() {
    const img = new Image();
    img.src = 'IMG_0327.jpeg';
    img.onload = () => {
        // Convert to base64 immediately so the dataUrl is portable across devices
        const cvt = document.createElement('canvas');
        cvt.width = img.naturalWidth; cvt.height = img.naturalHeight;
        cvt.getContext('2d').drawImage(img, 0, 0);
        let dataUrl;
        try { dataUrl = cvt.toDataURL('image/jpeg', 0.95); }
        catch(e) { dataUrl = img.src; } // file:// taint fallback — still register the image
        const newImgObj = {
            id: 'IMG_0327',
            name: 'IMG_0327.jpeg',
            dataUrl,
            width: img.naturalWidth,
            height: img.naturalHeight,
            scaleRatio: 1.5,
            scaleDistance: 10,
            origin: { x: Math.round(img.naturalWidth / 2), y: Math.round(img.naturalHeight / 2) },
            yAxisInverted: true,
            flakes: [],
            offset: { x: 0, y: 0 },
            imageEl: img
        };
        state.images.push(newImgObj);
        loadImage(newImgObj.id);
    };
    img.onerror = () => {
        createMockSubstrate();
    };
}

// Generate a gorgeous mock substrate if IMG_0327.jpeg is not directly accessible locally
function createMockSubstrate() {
    const mockCanvas = document.createElement('canvas');
    mockCanvas.width = 1920;
    mockCanvas.height = 1080;
    const mctx = mockCanvas.getContext('2d');
    
    // Substrate background (silicon dioxide purple/blue)
    const grad = mctx.createRadialGradient(960, 540, 100, 960, 540, 1000);
    grad.addColorStop(0, '#2e1c50'); // Oxide deep purple
    grad.addColorStop(1, '#1b1035');
    mctx.fillStyle = grad;
    mctx.fillRect(0, 0, 1920, 1080);
    
    // Add silicon chip speckles & noise
    mctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    for(let i=0; i<1000; i++) {
        mctx.fillRect(Math.random()*1920, Math.random()*1080, 1, 1);
    }
    
    // Draw photolithography alignment markers (crosshairs)
    mctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    mctx.lineWidth = 4;
    // Origin Mark (left corner)
    mctx.beginPath();
    mctx.arc(300, 300, 30, 0, Math.PI*2);
    mctx.moveTo(300, 250); mctx.lineTo(300, 350);
    mctx.moveTo(250, 300); mctx.lineTo(350, 300);
    mctx.stroke();
    mctx.fillStyle = 'rgba(255,255,255,0.7)';
    mctx.font = '14px Fira Code';
    mctx.fillText("MARK_A", 310, 290);
    
    // Right Mark
    mctx.beginPath();
    mctx.arc(1620, 780, 30, 0, Math.PI*2);
    mctx.moveTo(1620, 730); mctx.lineTo(1620, 830);
    mctx.moveTo(1570, 780); mctx.lineTo(1670, 780);
    mctx.stroke();
    mctx.fillText("MARK_B", 1630, 770);
    
    // Draw scale bar in bottom right corner (100 µm scale bar)
    // Let's assume 1.5 pixels = 1 µm, so 100 µm = 150 pixels
    mctx.fillStyle = 'white';
    mctx.fillRect(1650, 1000, 150, 8);
    mctx.font = '14px Inter';
    mctx.fillStyle = 'white';
    mctx.fillText("100 µm", 1700, 990);
    
    // Draw some gorgeous 2D Flakes (Graphene/MoS2 flakes with different thickness/colors)
    // Flake 1: Large Monolayer Graphene (Light teal/blue, faint)
    drawMockFlake(mctx, [
        {x: 800, y: 400}, {x: 950, y: 350}, {x: 1050, y: 450}, 
        {x: 1000, y: 550}, {x: 850, y: 580}, {x: 780, y: 500}
    ], 'rgba(6, 182, 212, 0.15)', 'rgba(6, 182, 212, 0.4)');
    
    // Flake 2: Bilayer Graphene (Slightly thicker, more contrast)
    drawMockFlake(mctx, [
        {x: 850, y: 450}, {x: 950, y: 420}, {x: 1000, y: 480}, 
        {x: 940, y: 530}, {x: 870, y: 520}
    ], 'rgba(6, 182, 212, 0.3)', 'rgba(6, 182, 212, 0.6)');
    
    // Flake 3: MoS2 triangular crystal (Greenish gold)
    drawMockFlake(mctx, [
        {x: 1200, y: 300}, {x: 1350, y: 380}, {x: 1180, y: 480}
    ], 'rgba(234, 179, 8, 0.25)', 'rgba(234, 179, 8, 0.6)');
    
    // Flake 4: Thick flake (Dark red/brown silicon residues)
    drawMockFlake(mctx, [
        {x: 500, y: 700}, {x: 580, y: 650}, {x: 650, y: 720}, 
        {x: 580, y: 780}, {x: 480, y: 750}
    ], 'rgba(239, 68, 68, 0.4)', 'rgba(239, 68, 68, 0.7)');

    const dataUrl = mockCanvas.toDataURL('image/png');
    const newImgObj = {
        id: 'mock_substrate',
        name: 'Mock_Substrate_100umScale.png',
        dataUrl: dataUrl,
        width: 1920,
        height: 1080,
        scaleRatio: 1.5, // 150px / 100um = 1.5 px/um
        scaleDistance: 100,
        origin: { x: 300, y: 300 }, // Alignment MARK_A
        yAxisInverted: true,
        flakes: [],
        offset: { x: 0, y: 0 }
    };
    state.images.push(newImgObj);
    loadImage(newImgObj.id);
}

function drawMockFlake(mctx, pts, fill, stroke) {
    mctx.fillStyle = fill;
    mctx.strokeStyle = stroke;
    mctx.lineWidth = 2;
    mctx.beginPath();
    mctx.moveTo(pts[0].x, pts[0].y);
    for(let i=1; i<pts.length; i++) {
        mctx.lineTo(pts[i].x, pts[i].y);
    }
    mctx.closePath();
    mctx.fill();
    mctx.stroke();
}

function preloadAllImages() {
    const promises = state.images.map(imgObj => {
        if (imgObj.imageEl && imgObj.imageEl.complete && imgObj.imageEl.naturalWidth > 0) {
            return Promise.resolve(imgObj.imageEl);
        }
        return new Promise((resolve) => {
            const img = new Image();
            // If dataUrl is a relative path (not a data URI) try to convert it to base64
            // so the canvas won't be tainted on any subsequent getImageData call
            const isDataUri = imgObj.dataUrl && imgObj.dataUrl.startsWith('data:');
            img.onload = () => {
                imgObj.imageEl = img;
                if (!isDataUri) {
                    // Upgrade to base64 now that we have the element
                    try {
                        const cvt = document.createElement('canvas');
                        cvt.width = img.naturalWidth; cvt.height = img.naturalHeight;
                        cvt.getContext('2d').drawImage(img, 0, 0);
                        imgObj.dataUrl = cvt.toDataURL('image/jpeg', 0.95);
                    } catch(e) { /* file:// taint — leave as-is */ }
                }
                resolve(img);
            };
            img.onerror = () => { resolve(null); };
            img.src = imgObj.dataUrl;
        });
    });
    return Promise.all(promises);
}

// Load Image into application
function loadImage(imageId) {
    const imgObj = state.images.find(img => img.id === imageId);
    if (!imgObj) return;
    
    state.activeImageId = imageId;
    state.scaleRatio = imgObj.scaleRatio;
    state.scaleDistance = imgObj.scaleDistance;
    state.origin = { ...imgObj.origin };
    state.yAxisInverted = imgObj.yAxisInverted;
    
    preloadAllImages().then(() => {
        const activeImg = state.images.find(img => img.id === imageId);
        if (!activeImg || !activeImg.imageEl) return;
        
        loadedImageEl = activeImg.imageEl;
        
        // Size canvas
        canvas.width = canvas.parentElement.clientWidth;
        canvas.height = canvas.parentElement.clientHeight;
        
        offscreenCanvas.width = loadedImageEl.naturalWidth;
        offscreenCanvas.height = loadedImageEl.naturalHeight;
        offscreenCtx.drawImage(loadedImageEl, 0, 0);

        // Detect tainted canvas (file:// protocol or cross-origin image)
        let imgData;
        try {
            imgData = offscreenCtx.getImageData(0, 0, offscreenCanvas.width, offscreenCanvas.height).data;
        } catch(e) {
            state.canvasTainted = true;
            showToast('⚠ Canvas tainted — pixel operations disabled. Use a local server (python -m http.server 8123).', 'error');
            redraw();
            return;
        }
        state.canvasTainted = false;
        let bgR = 0, bgG = 0, bgB = 0, bgCount = 0;
        const w = offscreenCanvas.width;
        const h = offscreenCanvas.height;
        // Sample every 40th pixel across the image
        for (let y = 10; y < h; y += 40) {
            for (let x = 10; x < w; x += 40) {
                const idx = (y * w + x) * 4;
                bgR += imgData[idx];
                bgG += imgData[idx+1];
                bgB += imgData[idx+2];
                bgCount++;
            }
        }
        state.backgroundRGB = {
            r: Math.round(bgR / bgCount),
            g: Math.round(bgG / bgCount),
            b: Math.round(bgB / bgCount)
        };
        console.log("Calculated Substrate Background Baseline (RGB):", state.backgroundRGB);
        
        if (state.filters.showBinary) {
            applyOffscreenFilters();
        }
        
        // Reset viewport zoom/pan to fit image
        resetViewport();
        
        // Populate inputs
        document.getElementById('input-scale').value = state.scaleRatio.toFixed(3);
        document.getElementById('input-origin-x').value = state.origin.x;
        document.getElementById('input-origin-y').value = state.origin.y;
        document.getElementById('input-axis-y').value = state.yAxisInverted ? 'cartesian' : 'image';
        
        // Update active image name below canvas
        const activeNameEl = document.getElementById('active-substrate-name');
        if (activeNameEl) {
            activeNameEl.textContent = activeImg.name;
        }
        
        // Render selector list
        renderSubstrateList();
        
        // Render flake lists
        renderFlakes();
        redraw();
    });
}

// Reset Viewport to fit canvas container
function resetViewport() {
    if (!loadedImageEl) return;
    
    const containerW = canvas.width;
    const containerH = canvas.height;
    const imgW = loadedImageEl.naturalWidth;
    const imgH = loadedImageEl.naturalHeight;
    
    const scaleX = containerW / imgW;
    const scaleY = containerH / imgH;
    state.zoom = Math.min(scaleX, scaleY, 1.0) * 0.95; // 95% fit
    
    state.pan.x = (containerW - imgW * state.zoom) / 2;
    state.pan.y = (containerH - imgH * state.zoom) / 2;
    
    updateZoomDisplay();
}

function updateZoomDisplay() {
    document.getElementById('zoom-factor').textContent = `${Math.round(state.zoom * 100)}%`;
}

// Setup Event Listeners
function setupEventListeners() {
    // Tool buttons click
    document.querySelectorAll('.tool-button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tool = btn.getAttribute('data-tool');
            if (state.tool === tool) {
                setTool('pan');
            } else {
                setTool(tool);
            }
        });
    });
    
    // Zoom control buttons
    document.getElementById('zoom-in-btn').addEventListener('click', () => {
        zoomCentered(1.2);
    });
    document.getElementById('zoom-out-btn').addEventListener('click', () => {
        zoomCentered(1/1.2);
    });
    document.getElementById('zoom-reset-btn').addEventListener('click', () => {
        resetViewport();
        redraw();
    });
    
    // Canvas Mouse events
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', () => {
        state.isPanning = false;
    });
    canvas.addEventListener('wheel', handleMouseWheel, { passive: false });
    
    // Custom context menu (right click)
    canvas.addEventListener('contextmenu', showCustomContextMenu);
    
    // Calibration parameters inputs change
    document.getElementById('input-scale').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        if (!isNaN(val) && val > 0) {
            state.scaleRatio = val;
            updateActiveImageConfig();
            recalculateAllFlakes();
            redraw();
        }
    });
    
    document.getElementById('input-origin-x').addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        if (!isNaN(val)) {
            state.origin.x = val;
            updateActiveImageConfig();
            recalculateAllFlakes();
            redraw();
        }
    });
    
    document.getElementById('input-origin-y').addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        if (!isNaN(val)) {
            state.origin.y = val;
            updateActiveImageConfig();
            recalculateAllFlakes();
            redraw();
        }
    });
    
    document.getElementById('input-axis-y').addEventListener('change', (e) => {
        state.yAxisInverted = (e.target.value === 'cartesian');
        updateActiveImageConfig();
        recalculateAllFlakes();
        redraw();
    });
    
    // Image Adjustment filters sliders
    const filterIds = ['contrast', 'brightness', 'threshold', 'tolerance', 'minSize', 'colorDistThreshold'];
    filterIds.forEach(id => {
        const slider = document.getElementById(`filter-${id}`);
        if (!slider) return; // guard — some sliders are conditionally hidden
        const displayVal = document.getElementById(`filter-${id}-val`);
        slider.addEventListener('input', (e) => {
            let val = parseFloat(e.target.value);
            if (id === 'threshold' || id === 'tolerance' || id === 'minSize' || id === 'colorDistThreshold') val = parseInt(val);
            state.filters[id] = val;
            if (displayVal) displayVal.textContent = val;

            if (id === 'contrast' || id === 'brightness' || id === 'threshold') {
                applyOffscreenFilters();
            }
            redraw();
        });
    });

    // Detection mode selector — switches between grayscale and color-distance strategies
    const colorModeSelect = document.getElementById('filter-colorMode');
    if (colorModeSelect) {
        colorModeSelect.addEventListener('change', (e) => {
            state.filters.colorMode = e.target.value;
            // Show/hide the relevant controls
            const grayscaleGroup = document.getElementById('grayscale-threshold-group');
            const colorDistGroup = document.getElementById('colorDist-group');
            if (grayscaleGroup) grayscaleGroup.style.display = (e.target.value === 'colorDist') ? 'none' : '';
            if (colorDistGroup)  colorDistGroup.style.display  = (e.target.value === 'colorDist') ? '' : 'none';
            redraw();
        });
    }
    
    document.getElementById('filter-binary-toggle').addEventListener('change', (e) => {
        state.filters.showBinary = e.target.checked;
        applyOffscreenFilters();
        redraw();
    });
    
    document.getElementById('filter-ignore-banner').addEventListener('change', (e) => {
        state.filters.ignoreBanner = e.target.checked;
        redraw();
    });
    
    document.getElementById('filter-show-crosshairs').addEventListener('change', (e) => {
        state.filters.showCrosshairs = e.target.checked;
        redraw();
    });

    document.getElementById('filter-show-labels').addEventListener('change', (e) => {
        state.filters.showLabels = e.target.checked;
        redraw();
    });

    // Advanced Segmentation controls
    const elWatershed = document.getElementById('filter-watershed-split');
    if (elWatershed) {
        elWatershed.addEventListener('change', (e) => {
            state.filters.watershedSplit = e.target.checked;
        });
    }
    const elMorph = document.getElementById('filter-morphological');
    const elKernelGroup = document.getElementById('morphology-kernel-group');
    if (elMorph) {
        elMorph.addEventListener('change', (e) => {
            state.filters.morphCleanup = e.target.checked;
            if (elKernelGroup) elKernelGroup.style.display = e.target.checked ? '' : 'none';
        });
    }
    const elKernel = document.getElementById('filter-erosionKernel');
    const elKernelVal = document.getElementById('filter-erosionKernel-val');
    if (elKernel) {
        elKernel.addEventListener('input', (e) => {
            state.filters.erosionKernel = parseInt(e.target.value);
            if (elKernelVal) elKernelVal.textContent = e.target.value;
        });
    }

    document.getElementById('btn-auto-scale').addEventListener('click', runAutoScaleBarCalibration);
    document.getElementById('btn-grid-layout').addEventListener('click', openGridModal);
    document.getElementById('btn-auto-stitch').addEventListener('click', autoStitchImages);
    document.getElementById('btn-stats').addEventListener('click', showStatsDashboard);
    document.getElementById('btn-stage-export').addEventListener('click', showStageExportMenu);

    // Flat-field correction
    const ffInput = document.getElementById('flat-field-input');
    if (ffInput) {
        ffInput.addEventListener('change', (e) => loadFlatField(e.target.files[0]));
    }
    const btnApplyFF = document.getElementById('btn-apply-flat-field');
    if (btnApplyFF) btnApplyFF.addEventListener('click', applyFlatFieldToOffscreen);
    const btnClearFF = document.getElementById('btn-flat-field-clear');
    if (btnClearFF) btnClearFF.addEventListener('click', clearFlatField);

    // File inputs & management
    document.getElementById('image-upload').addEventListener('change', handleImageUpload);
    document.getElementById('btn-export-csv').addEventListener('click', exportCSV);
    document.getElementById('btn-export-excel').addEventListener('click', exportExcel);
    document.getElementById('btn-export-jpg').addEventListener('click', exportJPG);
    document.getElementById('btn-export-json').addEventListener('click', exportJSON);
    document.getElementById('btn-import-json').addEventListener('click', () => {
        document.getElementById('json-import-input').click();
    });
    document.getElementById('json-import-input').addEventListener('change', handleJSONImport);
    document.getElementById('btn-generate-report').addEventListener('click', showReportModal);
    
    // Auto-detect flakes button
    document.getElementById('btn-auto-detect').addEventListener('click', autoDetectAllFlakes);
    
    // Undo / Redo buttons
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-redo').addEventListener('click', redo);
    
    // Resize canvas whenever its container changes size (window resize OR sidebar collapse/expand)
    if (canvas && canvas.parentElement && typeof ResizeObserver !== 'undefined') {
        const _canvasResizeObserver = new ResizeObserver(() => {
            if (!canvas || !canvas.parentElement) return;
            const w = canvas.parentElement.clientWidth;
            const h = canvas.parentElement.clientHeight;
            if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
                canvas.width = w;
                canvas.height = h;
                redraw();
            }
        });
        _canvasResizeObserver.observe(canvas.parentElement);
    }
    // Fallback for browsers without ResizeObserver
    window.addEventListener('resize', () => {
        if (!canvas || !canvas.parentElement) return;
        canvas.width = canvas.parentElement.clientWidth;
        canvas.height = canvas.parentElement.clientHeight;
        redraw();
    });

    // Global keyboard shortcuts
    window.addEventListener('keydown', (e) => {
        // Don't fire shortcuts when typing in inputs/textareas
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

        const ctrl = e.ctrlKey || e.metaKey;

        if (ctrl && e.key === 'z') { e.preventDefault(); undo(); return; }
        if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); redo(); return; }
        if (ctrl && e.key === '0') { e.preventDefault(); resetViewport(); redraw(); return; }
        if (ctrl && e.key === 'd') { e.preventDefault(); autoDetectAllFlakes(); return; }
        if (ctrl && e.shiftKey && e.key === 'S') { e.preventDefault(); showStatsDashboard(); return; }

        if (e.key === '?') { showKeyboardShortcuts(); return; }

        // Tool hotkeys (no modifier)
        if (!ctrl) {
            switch (e.key.toLowerCase()) {
                case 'v': setTool('pan'); break;
                case 's': setTool('scale'); break;
                case 'o': setTool('origin'); break;
                case 'b': setTool('box'); break;
                case 'p': setTool('polygon'); break;
                case 'f': setTool('floodfill'); break;
                case 'escape':
                    state.drawingPoints = [];
                    state.rboxStep = 0;
                    redraw();
                    break;
            }
        }
    });
}

function setTool(toolName) {
    state.tool = toolName;
    document.querySelectorAll('.tool-button').forEach(btn => {
        if (btn.getAttribute('data-tool') === toolName) {
            btn.classList.add('active-tool');
        } else {
            btn.classList.remove('active-tool');
        }
    });
    
    // Clear drawing state
    state.drawingPoints = [];
    state.rboxStep = 0;
    
    showToast(`Tool switched to: ${toolName.toUpperCase()}`, 'info');
    redraw();
}

function updateActiveImageConfig() {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (imgObj) {
        imgObj.scaleRatio = state.scaleRatio;
        imgObj.scaleDistance = state.scaleDistance;
        imgObj.origin = { ...state.origin };
        imgObj.yAxisInverted = state.yAxisInverted;
    }
}

// Convert screen canvas coordinate to image pixel coordinate (relative to active image local space)
function screenToPixel(screenX, screenY) {
    const activeImg = state.images.find(img => img.id === state.activeImageId);
    const offset = activeImg ? (activeImg.offset || { x: 0, y: 0 }) : { x: 0, y: 0 };
    return {
        x: Math.round((screenX - state.pan.x) / state.zoom) - offset.x,
        y: Math.round((screenY - state.pan.y) / state.zoom) - offset.y
    };
}

// Convert image pixel coordinate to screen canvas coordinate
function pixelToScreen(pixelX, pixelY) {
    const activeImg = state.images.find(img => img.id === state.activeImageId);
    const offset = activeImg ? (activeImg.offset || { x: 0, y: 0 }) : { x: 0, y: 0 };
    return {
        x: (pixelX + offset.x) * state.zoom + state.pan.x,
        y: (pixelY + offset.y) * state.zoom + state.pan.y
    };
}

// Convert pixel coordinate to physical micrometer coordinate (relative to origin)
function pixelToPhysical(pixelX, pixelY) {
    const dx = (pixelX - state.origin.x) / state.scaleRatio;
    const dy = (pixelY - state.origin.y) / state.scaleRatio;
    
    return {
        x: dx,
        y: state.yAxisInverted ? -dy : dy // Cartesian: y increases upwards, so diff in pixels decreases downwards
    };
}

// Handle Mouse Zooming relative to cursor position
function handleMouseWheel(e) {
    e.preventDefault();
    if (!loadedImageEl) return;
    const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    
    // Get mouse position relative to canvas
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const mousePixel = screenToPixel(mouseX, mouseY);
    
    const newZoom = Math.max(0.05, Math.min(20, state.zoom * zoomFactor));
    state.zoom = newZoom;
    
    // Adjust pan to zoom into cursor
    state.pan.x = mouseX - mousePixel.x * state.zoom;
    state.pan.y = mouseY - mousePixel.y * state.zoom;
    
    updateZoomDisplay();
    redraw();
}

function zoomCentered(factor) {
    if (!loadedImageEl) return;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const centerPixel = screenToPixel(cx, cy);
    
    state.zoom = Math.max(0.05, Math.min(20, state.zoom * factor));
    state.pan.x = cx - centerPixel.x * state.zoom;
    state.pan.y = cy - centerPixel.y * state.zoom;
    
    updateZoomDisplay();
    redraw();
}

// Canvas Interaction Logic
function handleMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    
    // Middle click or drag-tool active panning
    if (e.button === 1 || state.tool === 'pan' || (e.button === 0 && e.shiftKey)) {
        state.isPanning = true;
        state.panStart.x = screenX - state.pan.x;
        state.panStart.y = screenY - state.pan.y;
        state.panStartScreen = { x: screenX, y: screenY };
        return;
    }
    
    if (!loadedImageEl) return;
    
    if (e.button === 0) { // Left click
        if (state.tool === 'stitch') {
            const globalX = Math.round((screenX - state.pan.x) / state.zoom);
            const globalY = Math.round((screenY - state.pan.y) / state.zoom);
            
            let clickedImg = null;
            for (let i = state.images.length - 1; i >= 0; i--) {
                const img = state.images[i];
                const ox = img.offset ? img.offset.x : 0;
                const oy = img.offset ? img.offset.y : 0;
                if (globalX >= ox && globalX < ox + img.width && globalY >= oy && globalY < oy + img.height) {
                    clickedImg = img;
                    break;
                }
            }
            
            if (clickedImg) {
                state.draggingImageId = clickedImg.id;
                state.stitchStart = { x: globalX, y: globalY };
                state.stitchImageOffset = { ...(clickedImg.offset || { x: 0, y: 0 }) };
                // Bug fix #8: removed loadImage() call here — it was resetting zoom/pan
                // and re-running all setup work on every drag-start unnecessarily.
            }
            return;
        }
        
        if (state.tool === 'snip') {
            const globalX = Math.round((screenX - state.pan.x) / state.zoom);
            const globalY = Math.round((screenY - state.pan.y) / state.zoom);
            state.drawingPoints = [{ x: globalX, y: globalY }];
            return;
        }

        if (state.tool === 'crop') {
            const globalX = Math.round((screenX - state.pan.x) / state.zoom);
            const globalY = Math.round((screenY - state.pan.y) / state.zoom);
            state.drawingPoints = [{ x: globalX, y: globalY }];
            return;
        }

        const pix = screenToPixel(screenX, screenY);

        if (state.tool === 'ignore') {
            // Check if clicked on a corner handle of the selected ignore area
            if (state.selectedIgnoreAreaIndex !== null) {
                const idx = state.selectedIgnoreAreaIndex;
                const area = state.ignoreAreas[idx];
                if (area) {
                    const handleDist = 8 / state.zoom;
                    
                    // Top-right close button hit check
                    const closeX = area.maxX - 6 / state.zoom;
                    const closeY = area.minY + 6 / state.zoom;
                    const distToClose = Math.sqrt((pix.x - closeX)**2 + (pix.y - closeY)**2);
                    if (distToClose < 12 / state.zoom) {
                        pushToUndoStack();
                        state.ignoreAreas.splice(idx, 1);
                        state.selectedIgnoreAreaIndex = null;
                        showToast("Ignore Area removed", "info");
                        redraw();
                        return;
                    }
                    
                    // Corner drag resize handle checks
                    if (Math.abs(pix.x - area.minX) < handleDist && Math.abs(pix.y - area.minY) < handleDist) {
                        pushToUndoStack();
                        state.resizingIgnoreAreaIndex = idx;
                        state.resizeHandle = 'nw';
                        return;
                    } else if (Math.abs(pix.x - area.maxX) < handleDist && Math.abs(pix.y - area.minY) < handleDist) {
                        pushToUndoStack();
                        state.resizingIgnoreAreaIndex = idx;
                        state.resizeHandle = 'ne';
                        return;
                    } else if (Math.abs(pix.x - area.maxX) < handleDist && Math.abs(pix.y - area.maxY) < handleDist) {
                        pushToUndoStack();
                        state.resizingIgnoreAreaIndex = idx;
                        state.resizeHandle = 'se';
                        return;
                    } else if (Math.abs(pix.x - area.minX) < handleDist && Math.abs(pix.y - area.maxY) < handleDist) {
                        pushToUndoStack();
                        state.resizingIgnoreAreaIndex = idx;
                        state.resizeHandle = 'sw';
                        return;
                    }
                }
            }
            
            // Check if clicked inside any ignore area to select it (or click border)
            let clickedIdx = -1;
            for (let i = state.ignoreAreas.length - 1; i >= 0; i--) {
                const area = state.ignoreAreas[i];
                if (pix.x >= area.minX && pix.x <= area.maxX && pix.y >= area.minY && pix.y <= area.maxY) {
                    clickedIdx = i;
                    break;
                }
            }
            
            if (clickedIdx !== -1) {
                pushToUndoStack();
                state.selectedIgnoreAreaIndex = clickedIdx;
                state.resizingIgnoreAreaIndex = clickedIdx;
                state.resizeHandle = 'move';
                state.stitchStart = { x: pix.x, y: pix.y };
                const area = state.ignoreAreas[clickedIdx];
                state.stitchImageOffset = { minX: area.minX, maxX: area.maxX, minY: area.minY, maxY: area.maxY };
                showToast(`Ignore Area #${clickedIdx+1} selected`, "info");
                redraw();
                return;
            } else {
                state.selectedIgnoreAreaIndex = null;
                redraw();
            }
        }
        
        // Bounds checking
        if (pix.x < 0 || pix.x >= offscreenCanvas.width || pix.y < 0 || pix.y >= offscreenCanvas.height) {
            return;
        }
        
        switch (state.tool) {
            case 'ignore':
                state.drawingPoints = [pix];
                break;
                
            case 'scale':
                state.drawingPoints = [pix];
                break;
                
            case 'origin':
                state.origin = { ...pix };
                document.getElementById('input-origin-x').value = pix.x;
                document.getElementById('input-origin-y').value = pix.y;
                updateActiveImageConfig();
                recalculateAllFlakes();
                showToast(`Coordinate Origin moved to (${pix.x}, ${pix.y})px`, 'info');
                redraw();
                break;
                
            case 'box':
                state.drawingPoints = [pix];
                break;
                
            case 'rbox':
                if (state.rboxStep === 0) {
                    state.drawingPoints = [pix];
                    state.rboxStep = 1;
                } else if (state.rboxStep === 1) {
                    state.drawingPoints.push(pix);
                    state.rboxStep = 2;
                } else if (state.rboxStep === 2) {
                    // Complete rotated box
                    state.drawingPoints.push(pix);
                    createRotatedBoxFlake();
                }
                break;
                
            case 'polygon':
                if (state.drawingPoints.length > 2 && distancePixels(pix, state.drawingPoints[0]) < 15 / state.zoom) {
                    // Clicked near starting point, close polygon
                    createPolygonFlake();
                } else {
                    state.drawingPoints.push(pix);
                }
                break;
                
            case 'floodfill':
                runAutoSegmentation(pix);
                break;
        }
        redraw();
    }
}

function handleMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    
    // Panning update
    if (state.isPanning) {
        state.pan.x = screenX - state.panStart.x;
        state.pan.y = screenY - state.panStart.y;
        redraw();
        return;
    }
    
    if (!loadedImageEl) return;
    
    if (state.tool === 'stitch' && state.draggingImageId) {
        const globalX = Math.round((screenX - state.pan.x) / state.zoom);
        const globalY = Math.round((screenY - state.pan.y) / state.zoom);
        
        const dx = globalX - state.stitchStart.x;
        const dy = globalY - state.stitchStart.y;
        
        const draggedImg = state.images.find(img => img.id === state.draggingImageId);
        if (draggedImg) {
            if (!draggedImg.offset) draggedImg.offset = { x: 0, y: 0 };
            draggedImg.offset.x = state.stitchImageOffset.x + dx;
            draggedImg.offset.y = state.stitchImageOffset.y + dy;
            redraw();
        }
        return;
    }
    
    if (state.tool === 'snip' && state.drawingPoints.length > 0) {
        const globalX = Math.round((screenX - state.pan.x) / state.zoom);
        const globalY = Math.round((screenY - state.pan.y) / state.zoom);
        redraw();
        drawTemporarySnipBox({ x: globalX, y: globalY });
        return;
    }

    if (state.tool === 'crop' && state.drawingPoints.length > 0) {
        const globalX = Math.round((screenX - state.pan.x) / state.zoom);
        const globalY = Math.round((screenY - state.pan.y) / state.zoom);
        redraw();
        drawCropPreview({ x: globalX, y: globalY });
        return;
    }
    
    const pix = screenToPixel(screenX, screenY);
    updateCoordsDisplay(pix);
    
    if (state.tool === 'ignore') {
        // 1. If currently resizing/moving
        if (state.resizingIgnoreAreaIndex !== null && state.resizeHandle) {
            const idx = state.resizingIgnoreAreaIndex;
            const area = state.ignoreAreas[idx];
            const orig = state.stitchImageOffset; // original bounds
            
            if (state.resizeHandle === 'move') {
                const dx = pix.x - state.stitchStart.x;
                const dy = pix.y - state.stitchStart.y;
                
                area.minX = orig.minX + dx;
                area.maxX = orig.maxX + dx;
                area.minY = orig.minY + dy;
                area.maxY = orig.maxY + dy;
            } else {
                if (state.resizeHandle === 'nw') {
                    area.minX = Math.min(pix.x, area.maxX - 10);
                    area.minY = Math.min(pix.y, area.maxY - 10);
                } else if (state.resizeHandle === 'ne') {
                    area.maxX = Math.max(pix.x, area.minX + 10);
                    area.minY = Math.min(pix.y, area.maxY - 10);
                } else if (state.resizeHandle === 'se') {
                    area.maxX = Math.max(pix.x, area.minX + 10);
                    area.maxY = Math.max(pix.y, area.minY + 10);
                } else if (state.resizeHandle === 'sw') {
                    area.minX = Math.min(pix.x, area.maxX - 10);
                    area.maxY = Math.max(pix.y, area.minY + 10);
                }
            }
            redraw();
            return;
        }
        
        // 2. If drawing a new ignore area
        if (state.drawingPoints.length > 0) {
            redraw();
            drawTemporaryIgnoreBox(pix);
            return;
        }
        
        // 3. Hover state detection (to change mouse cursor dynamically)
        let hoveredIdx = -1;
        let cursorStyle = 'default';
        
        if (state.selectedIgnoreAreaIndex !== null) {
            const idx = state.selectedIgnoreAreaIndex;
            const area = state.ignoreAreas[idx];
            if (area) {
                const handleDist = 8 / state.zoom;
                
                const closeX = area.maxX - 6 / state.zoom;
                const closeY = area.minY + 6 / state.zoom;
                const distToClose = Math.sqrt((pix.x - closeX)**2 + (pix.y - closeY)**2);
                if (distToClose < 12 / state.zoom) {
                    cursorStyle = 'pointer';
                } else if (Math.abs(pix.x - area.minX) < handleDist && Math.abs(pix.y - area.minY) < handleDist) {
                    cursorStyle = 'nwse-resize';
                } else if (Math.abs(pix.x - area.maxX) < handleDist && Math.abs(pix.y - area.minY) < handleDist) {
                    cursorStyle = 'nesw-resize';
                } else if (Math.abs(pix.x - area.maxX) < handleDist && Math.abs(pix.y - area.maxY) < handleDist) {
                    cursorStyle = 'nwse-resize';
                } else if (Math.abs(pix.x - area.minX) < handleDist && Math.abs(pix.y - area.maxY) < handleDist) {
                    cursorStyle = 'nesw-resize';
                }
            }
        }
        
        if (cursorStyle === 'default') {
            for (let i = state.ignoreAreas.length - 1; i >= 0; i--) {
                const area = state.ignoreAreas[i];
                if (pix.x >= area.minX && pix.x <= area.maxX && pix.y >= area.minY && pix.y <= area.maxY) {
                    hoveredIdx = i;
                    cursorStyle = 'move';
                    break;
                }
            }
        }
        
        canvas.style.cursor = cursorStyle;
        
        if (state.hoveredIgnoreAreaIndex !== hoveredIdx) {
            state.hoveredIgnoreAreaIndex = hoveredIdx;
            redraw();
        }
    }
    
    // Check hover state for existing flakes
    checkHoverState(pix);
    
    // Draw tracking lines based on active drawing
    if (state.drawingPoints.length > 0) {
        if (state.tool === 'scale' || state.tool === 'box' || state.tool === 'polygon' || state.tool === 'rbox') {
            redraw(); // triggers drawing code to render the active dynamic guide line
            drawTemporaryGuideline(pix);
        }
    }
}

function handleMouseUp(e) {
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    
    if (state.isPanning) {
        state.isPanning = false;
        
        // If pan tool click was a quick tap with minimal movement, perform selection logic
        if (state.panStartScreen && state.tool === 'pan') {
            const dx = screenX - state.panStartScreen.x;
            const dy = screenY - state.panStartScreen.y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist < 5) {
                if (state.hoveredFlakeId) {
                    selectFlake(state.hoveredFlakeId);
                } else {
                    // Bug fix #11: clicking empty space clears selection directly rather
                    // than calling selectFlake(selectedId) which would toggle it off via
                    // the id-match branch — a confusing double-negative deselect.
                    state.selectedFlakeId = null;
                    renderFlakes();
                    redraw();
                }
            }
        }
        return;
    }
    
    if (!loadedImageEl) {
        state.draggingImageId = null;
        state.drawingPoints = [];
        return;
    }
    
    if (state.tool === 'stitch') {
        if (state.draggingImageId) {
            state.draggingImageId = null;
            showToast("Stitch alignment updated", "success");
        }
        return;
    }
    
    if (state.tool === 'ignore') {
        if (state.resizingIgnoreAreaIndex !== null) {
            state.resizingIgnoreAreaIndex = null;
            state.resizeHandle = null;
            
            // Clean up any tiny ignore areas
            state.ignoreAreas = state.ignoreAreas.filter(area => {
                return (area.maxX - area.minX > 5 && area.maxY - area.minY > 5);
            });
            
            // Also filter out any existing flakes in the active image that are now covered by this moved/resized area
            const activeImg = state.images.find(img => img.id === state.activeImageId);
            if (activeImg) {
                const beforeCount = activeImg.flakes.length;
                activeImg.flakes = activeImg.flakes.filter(f => {
                    if (!f.centroid) return true;
                    const cx = f.centroid.x;
                    const cy = f.centroid.y;
                    
                    // Check if centroid falls within ANY ignore area
                    let isInside = false;
                    for (let i = 0; i < state.ignoreAreas.length; i++) {
                        const area = state.ignoreAreas[i];
                        if (cx >= area.minX && cx <= area.maxX && cy >= area.minY && cy <= area.maxY) {
                            isInside = true;
                            break;
                        }
                    }
                    return !isInside;
                });
                const removedCount = beforeCount - activeImg.flakes.length;
                if (removedCount > 0) {
                    showToast(`Ignore Area updated. Removed ${removedCount} overlapping flakes.`, "success");
                    renderFlakes();
                } else {
                    showToast("Ignore Area updated", "success");
                }
            }
            
            redraw();
            return;
        }
        
        if (state.drawingPoints.length > 0) {
            const start = state.drawingPoints[0];
            const pix = screenToPixel(screenX, screenY);
            
            const minX = Math.min(start.x, pix.x);
            const maxX = Math.max(start.x, pix.x);
            const minY = Math.min(start.y, pix.y);
            const maxY = Math.max(start.y, pix.y);
            
            if (maxX - minX > 5 && maxY - minY > 5) {
                pushToUndoStack();
                state.ignoreAreas.push({ minX, maxX, minY, maxY });
                state.selectedIgnoreAreaIndex = state.ignoreAreas.length - 1; // select new
                
                // Immediately remove any existing flakes in the active image whose centroid falls inside this new ignore area
                const activeImg = state.images.find(img => img.id === state.activeImageId);
                if (activeImg) {
                    const beforeCount = activeImg.flakes.length;
                    activeImg.flakes = activeImg.flakes.filter(f => {
                        if (!f.centroid) return true;
                        const cx = f.centroid.x;
                        const cy = f.centroid.y;
                        const isInside = (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY);
                        return !isInside;
                    });
                    const removedCount = beforeCount - activeImg.flakes.length;
                    if (removedCount > 0) {
                        showToast(`Custom Ignore Area defined. Removed ${removedCount} overlapping flakes.`, "success");
                        renderFlakes();
                    } else {
                        showToast("Custom Ignore Area defined", "success");
                    }
                } else {
                    showToast("Custom Ignore Area defined", "success");
                }
            }
            state.drawingPoints = [];
            setTool('pan');
            redraw();
        }
        return;
    }
    
    if (state.tool === 'snip') {
        if (state.drawingPoints.length > 0) {
            const start = state.drawingPoints[0];
            const globalX = Math.round((screenX - state.pan.x) / state.zoom);
            const globalY = Math.round((screenY - state.pan.y) / state.zoom);

            const minX = Math.min(start.x, globalX);
            const maxX = Math.max(start.x, globalX);
            const minY = Math.min(start.y, globalY);
            const maxY = Math.max(start.y, globalY);

            const w = maxX - minX;
            const h = maxY - minY;

            state.drawingPoints = [];

            if (w > 10 && h > 10) {
                triggerSnipExport(minX, minY, w, h);
            } else {
                showToast("Snip region too small", "warning");
            }
            setTool('pan');
        }
        return;
    }

    if (state.tool === 'crop') {
        if (state.drawingPoints.length > 0) {
            const start = state.drawingPoints[0];
            const globalX = Math.round((screenX - state.pan.x) / state.zoom);
            const globalY = Math.round((screenY - state.pan.y) / state.zoom);

            const minX = Math.min(start.x, globalX);
            const maxX = Math.max(start.x, globalX);
            const minY = Math.min(start.y, globalY);
            const maxY = Math.max(start.y, globalY);

            const w = maxX - minX;
            const h = maxY - minY;

            state.drawingPoints = [];

            if (w > 10 && h > 10) {
                applyCropToActiveImage(minX, minY, w, h);
            } else {
                showToast("Crop region too small", "warning");
                redraw();
            }
            setTool('pan');
        }
        return;
    }
    
    const pix = screenToPixel(screenX, screenY);
    
    if (e.button === 0 && state.drawingPoints.length > 0) {
        if (state.tool === 'scale') {
            const p1 = state.drawingPoints[0];
            const p2 = pix;
            const distPx = distancePixels(p1, p2);
            if (distPx > 5) {
                const midY = (p1.y + p2.y) / 2;
                calibrateScalePrompt(distPx, midY);
            }
            state.drawingPoints = [];
        } else if (state.tool === 'box') {
            const p1 = state.drawingPoints[0];
            const p2 = pix;
            if (Math.abs(p1.x - p2.x) > 4 && Math.abs(p1.y - p2.y) > 4) {
                createBoxFlake(p1, p2);
            }
            state.drawingPoints = [];
        }
        redraw();
    }
}

function drawTemporaryGuideline(currentPix) {
    ctx.save();
    ctx.setTransform(state.zoom, 0, 0, state.zoom, state.pan.x, state.pan.y);
    
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.8)';
    ctx.lineWidth = 2 / state.zoom;
    ctx.fillStyle = 'rgba(6, 182, 212, 0.2)';
    
    const start = state.drawingPoints[0];
    
    if (state.tool === 'scale') {
        // Draw line
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(currentPix.x, currentPix.y);
        ctx.stroke();
    } else if (state.tool === 'box') {
        // Draw rectangle
        ctx.beginPath();
        ctx.rect(start.x, start.y, currentPix.x - start.x, currentPix.y - start.y);
        ctx.stroke();
        ctx.fill();
    } else if (state.tool === 'polygon') {
        // Draw running polygon lines
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        for(let i=1; i<state.drawingPoints.length; i++) {
            ctx.lineTo(state.drawingPoints[i].x, state.drawingPoints[i].y);
        }
        ctx.lineTo(currentPix.x, currentPix.y);
        
        // Highlight closing point
        if (state.drawingPoints.length > 2 && distancePixels(currentPix, start) < 15 / state.zoom) {
            ctx.strokeStyle = 'rgba(16, 185, 129, 1)';
            ctx.fillStyle = 'rgba(16, 185, 129, 0.4)';
            ctx.arc(start.x, start.y, 8 / state.zoom, 0, Math.PI*2);
            ctx.fill();
        }
        ctx.stroke();
    } else if (state.tool === 'rbox') {
        if (state.rboxStep === 1) {
            // Point A clicked, tracing vector AB
            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(currentPix.x, currentPix.y);
            ctx.stroke();
        } else if (state.rboxStep === 2) {
            // Points A and B clicked, tracing height to current point C
            const p1 = start;
            const p2 = state.drawingPoints[1];
            const p3 = currentPix;
            
            // Math for rotated rectangle guidelines
            const theta = Math.atan2(p2.y - p1.y, p2.x - p1.x);
            const L = distancePixels(p1, p2);
            
            const nx = -Math.sin(theta);
            const ny = Math.cos(theta);
            const dx = p3.x - p1.x;
            const dy = p3.y - p1.y;
            const W = dx * nx + dy * ny;
            
            const p4 = { x: p1.x + W * nx, y: p1.y + W * ny };
            const p3Proj = { x: p2.x + W * nx, y: p2.y + W * ny };
            
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.lineTo(p3Proj.x, p3Proj.y);
            ctx.lineTo(p4.x, p4.y);
            ctx.closePath();
            ctx.stroke();
            ctx.fill();
        }
    }
    
    ctx.restore();
}

// Live Mouse cursor readouts
function updateCoordsDisplay(pix) {
    const pxDiv = document.getElementById('cursor-pixels');
    const umDiv = document.getElementById('cursor-microns');
    
    if (pix.x >= 0 && pix.x < offscreenCanvas.width && pix.y >= 0 && pix.y < offscreenCanvas.height) {
        pxDiv.innerHTML = `Pixel: [<strong>${pix.x}</strong>, <strong>${pix.y}</strong>]`;
        
        const phys = pixelToPhysical(pix.x, pix.y);
        umDiv.innerHTML = `Substrate: [<strong>${phys.x.toFixed(2)}</strong>, <strong>${phys.y.toFixed(2)}</strong>] µm`;
    } else {
        pxDiv.innerHTML = `Pixel: [--, --]`;
        umDiv.innerHTML = `Substrate: [--, --] µm`;
    }
}

// Hover state checking
function checkHoverState(pix) {
    let hoveredId = null;
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj || state.isPanning) return;
    
    // Check reverse order so top drawn items highlight first
    for (let i = imgObj.flakes.length - 1; i >= 0; i--) {
        const flake = imgObj.flakes[i];
        if (isPointInFlake(pix, flake)) {
            hoveredId = flake.id;
            break;
        }
    }
    
    if (state.hoveredFlakeId !== hoveredId) {
        state.hoveredFlakeId = hoveredId;
        redraw();
        highlightTableRow(hoveredId);
    }
}

function isPointInFlake(pt, flake) {
    // 1. Quick bounding box check
    const bbox = flake.boundingBox;
    if (pt.x < bbox.minX || pt.x > bbox.maxX || pt.y < bbox.minY || pt.y > bbox.maxY) {
        return false;
    }
    
    // 2. Exact polygon ray-casting check
    if (flake.type === 'polygon' || flake.type === 'floodfill') {
        let inside = false;
        const pts = flake.points;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const xi = pts[i].x, yi = pts[i].y;
            const xj = pts[j].x, yj = pts[j].y;
            const intersect = ((yi > pt.y) !== (yj > pt.y)) && 
                (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi + 0.0001) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    } else if (flake.type === 'box' || flake.type === 'rbox') {
        // Rotated box coordinate projection check
        let inside = false;
        const pts = flake.orientedBox;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const xi = pts[i].x, yi = pts[i].y;
            const xj = pts[j].x, yj = pts[j].y;
            const intersect = ((yi > pt.y) !== (yj > pt.y)) && 
                (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi + 0.0001) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
    return false;
}

// Distance math utility
function distancePixels(p1, p2) {
    return Math.sqrt((p1.x - p2.x)**2 + (p1.y - p2.y)**2);
}

// Scale calibration prompt modal
function calibrateScalePrompt(distPx, lineY) {
    const distUmStr = prompt(`You drew a calibration line of ${Math.round(distPx)} pixels.\nPlease enter its real distance in micrometers (µm):`, state.scaleDistance);
    const distUm = parseFloat(distUmStr);

    if (!isNaN(distUm) && distUm > 0) {
        state.scaleDistance = distUm;
        state.scaleRatio = distPx / distUm;

        document.getElementById('input-scale').value = state.scaleRatio.toFixed(3);
        updateActiveImageConfig();
        recalculateAllFlakes();
        showToast(`Scale calibrated: ${state.scaleRatio.toFixed(3)} px/µm`, 'success');

        // If the drawn line is in the bottom 25% it's likely on the scale bar banner
        if (lineY != null && loadedImageEl && lineY > loadedImageEl.naturalHeight * 0.75) {
            // Reconstruct a line-like object from the drawn ruler
            _registerScaleBarIgnoreArea({ startX: 0, length: distPx, y: lineY });
        }

        redraw();
        setTool('pan');
    }
}

// Recalculate dimensions of all flakes when scale/origin changes
function recalculateAllFlakes() {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj) return;
    
    imgObj.flakes.forEach(flake => {
        if (flake.type === 'polygon' || flake.type === 'floodfill') {
            const metrics = calculateShapeMoments(flake.points);
            Object.assign(flake, metrics);
        } else if (flake.type === 'box') {
            const p1 = flake.points[0];
            const p2 = flake.points[1];
            const widthPx = Math.abs(p1.x - p2.x);
            const heightPx = Math.abs(p1.y - p2.y);
            flake.length = Math.max(widthPx, heightPx) / state.scaleRatio;
            flake.width = Math.min(widthPx, heightPx) / state.scaleRatio;
            flake.area = (widthPx * heightPx) / (state.scaleRatio**2);
            flake.centroid = { x: (p1.x + p2.x)/2, y: (p1.y + p2.y)/2 };
        } else if (flake.type === 'rbox') {
            const metrics = calculateRotatedBoxMetrics(flake.points);
            Object.assign(flake, metrics);
        }
        
        // Recalculate physical positions
        const physCentroid = pixelToPhysical(flake.centroid.x, flake.centroid.y);
        flake.x_um = physCentroid.x;
        flake.y_um = physCentroid.y;
    });
    
    renderFlakes();
}

// ----------------------------------------------------
// Mathematical Engine (Algebraic Moments & OBB Calculation)
// ----------------------------------------------------

function calculateShapeMoments(pts) {
    const n = pts.length;
    if (n < 3) return { length: 0, width: 0, area: 0, centroid: {x:0, y:0}, orientation: 0, orientedBox: [] };
    
    // Close polygon if not closed
    const poly = [...pts];
    if (poly[0].x !== poly[n-1].x || poly[0].y !== poly[n-1].y) {
        poly.push({ ...poly[0] });
    }
    const len = poly.length;
    
    // Calculates Area (M00) and raw centroid moments
    let M00 = 0;
    let M10 = 0;
    let M01 = 0;
    let M20 = 0;
    let M02 = 0;
    let M11 = 0;
    
    for (let i = 0; i < len - 1; i++) {
        const p1 = poly[i];
        const p2 = poly[i+1];
        
        // Cross product term
        const cross = (p1.x * p2.y - p2.x * p1.y);
        M00 += cross;
        M10 += (p1.x + p2.x) * cross;
        M01 += (p1.y + p2.y) * cross;
        M20 += (p1.x**2 + p1.x * p2.x + p2.x**2) * cross;
        M02 += (p1.y**2 + p1.y * p2.y + p2.y**2) * cross;
        M11 += (2 * p1.x * p1.y + p1.x * p2.y + p2.x * p1.y + 2 * p2.x * p2.y) * cross;
    }
    
    M00 = M00 / 2;
    if (Math.abs(M00) < 0.1) return { length: 0, width: 0, area: 0, centroid: {x:pts[0].x, y:pts[0].y}, orientation: 0, orientedBox: [] };
    
    const cx = M10 / (6 * M00);
    const cy = M01 / (6 * M00);
    
    M20 = M20 / 12;
    M02 = M02 / 12;
    M11 = M11 / 24;
    
    // Central moments (relative to centroid)
    const mu20 = M20 - cx * cx * M00;
    const mu02 = M02 - cy * cy * M00;
    const mu11 = M11 - cx * cy * M00;
    
    // Principal orientation angle
    let theta = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
    
    // Calculate Oriented Bounding Box by projecting vertices onto rotated axes
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    
    let minU = Infinity, maxU = -Infinity;
    let minV = Infinity, maxV = -Infinity;
    
    pts.forEach(p => {
        // Project onto centroid local coordinate frame
        const u = (p.x - cx) * cosT + (p.y - cy) * sinT;
        const v = -(p.x - cx) * sinT + (p.y - cy) * cosT;
        
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
    });
    
    const lengthPx = maxU - minU;
    const widthPx = maxV - minV;
    
    // Calculate the oriented box corners in pixel coordinates
    const orientedBox = [
        { u: minU, v: minV },
        { u: maxU, v: minV },
        { u: maxU, v: maxV },
        { u: minU, v: maxV }
    ].map(uv => {
        return {
            x: cx + uv.u * cosT - uv.v * sinT,
            y: cy + uv.u * sinT + uv.v * cosT
        };
    });
    
    // Physical measurements
    const length = lengthPx / state.scaleRatio;
    const width = widthPx / state.scaleRatio;
    const area = Math.abs(M00) / (state.scaleRatio**2);
    const orientationDeg = (theta * 180 / Math.PI);
    
    return {
        centroid: { x: cx, y: cy },
        length: Math.max(length, width),
        width: Math.min(length, width),
        area: area,
        orientation: Math.round(orientationDeg * 10) / 10,
        orientedBox: orientedBox
    };
}

function calculateRotatedBoxMetrics(pts) {
    const p1 = pts[0];
    const p2 = pts[1];
    const p3 = pts[2];
    
    const theta = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const lengthPx = distancePixels(p1, p2);
    
    // Vector AB normal
    const nx = -Math.sin(theta);
    const ny = Math.cos(theta);
    const dx = p3.x - p1.x;
    const dy = p3.y - p1.y;
    const widthPx = dx * nx + dy * ny;
    
    const sign = Math.sign(widthPx);
    const absWidthPx = Math.abs(widthPx);
    
    const p4 = { x: p1.x + widthPx * nx, y: p1.y + widthPx * ny };
    const p3Proj = { x: p2.x + widthPx * nx, y: p2.y + widthPx * ny };
    
    const orientedBox = [p1, p2, p3Proj, p4];
    
    // Centroid
    const cx = (p1.x + p2.x + p3Proj.x + p4.x) / 4;
    const cy = (p1.y + p2.y + p3Proj.y + p4.y) / 4;
    
    return {
        centroid: { x: cx, y: cy },
        length: Math.max(lengthPx, absWidthPx) / state.scaleRatio,
        width: Math.min(lengthPx, absWidthPx) / state.scaleRatio,
        area: (lengthPx * absWidthPx) / (state.scaleRatio**2),
        orientation: Math.round((theta * 180 / Math.PI) * 10) / 10,
        orientedBox: orientedBox
    };
}

// Create flakes from annotations
function createBoxFlake(p1, p2) {
    pushToUndoStack();
    const color = COLORS[colorIndex % COLORS.length];
    colorIndex++;
    
    const minX = Math.min(p1.x, p2.x);
    const maxX = Math.max(p1.x, p2.x);
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);
    
    const orientedBox = [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY }
    ];
    
    const widthPx = maxX - minX;
    const heightPx = maxY - minY;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const physCentroid = pixelToPhysical(cx, cy);
    
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj) return;
    
    const newFlake = {
        id: `flake_${Date.now()}`,
        name: `${imgObj.flakes.length + 1}`,
        color: color,
        type: 'box',
        points: [{ ...p1 }, { ...p2 }],
        centroid: { x: cx, y: cy },
        boundingBox: { minX, maxX, minY, maxY },
        orientedBox: orientedBox,
        length: Math.max(widthPx, heightPx) / state.scaleRatio,
        width: Math.min(widthPx, heightPx) / state.scaleRatio,
        area: (widthPx * heightPx) / (state.scaleRatio**2),
        orientation: widthPx >= heightPx ? 0 : -90,
        x_um: physCentroid.x,
        y_um: physCentroid.y,
        customTag: 'manual-box'
    };
    
    imgObj.flakes.push(newFlake);
    renderFlakes();
}

function createRotatedBoxFlake() {
    pushToUndoStack();
    const p1 = state.drawingPoints[0];
    const p2 = state.drawingPoints[1];
    const p3 = state.drawingPoints[2];
    
    const metrics = calculateRotatedBoxMetrics([p1, p2, p3]);
    const color = COLORS[colorIndex % COLORS.length];
    colorIndex++;
    
    // Bounds
    const xs = metrics.orientedBox.map(p => p.x);
    const ys = metrics.orientedBox.map(p => p.y);
    
    const physCentroid = pixelToPhysical(metrics.centroid.x, metrics.centroid.y);
    
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj) return;
    
    const newFlake = {
        id: `flake_${Date.now()}`,
        name: `${imgObj.flakes.length + 1}`,
        color: color,
        type: 'rbox',
        points: [...state.drawingPoints],
        centroid: metrics.centroid,
        boundingBox: {
            minX: Math.min(...xs),
            maxX: Math.max(...xs),
            minY: Math.min(...ys),
            maxY: Math.max(...ys)
        },
        orientedBox: metrics.orientedBox,
        length: metrics.length,
        width: metrics.width,
        area: metrics.area,
        orientation: metrics.orientation,
        x_um: physCentroid.x,
        y_um: physCentroid.y,
        customTag: 'manual-rotbox'
    };
    
    imgObj.flakes.push(newFlake);
    state.drawingPoints = [];
    state.rboxStep = 0;
    renderFlakes();
}

function createPolygonFlake() {
    pushToUndoStack();
    const metrics = calculateShapeMoments(state.drawingPoints);
    const color = COLORS[colorIndex % COLORS.length];
    colorIndex++;
    
    const xs = state.drawingPoints.map(p => p.x);
    const ys = state.drawingPoints.map(p => p.y);
    
    const physCentroid = pixelToPhysical(metrics.centroid.x, metrics.centroid.y);
    
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj) return;
    
    const newFlake = {
        id: `flake_${Date.now()}`,
        name: `${imgObj.flakes.length + 1}`,
        color: color,
        type: 'polygon',
        points: [...state.drawingPoints],
        centroid: metrics.centroid,
        boundingBox: {
            minX: Math.min(...xs),
            maxX: Math.max(...xs),
            minY: Math.min(...ys),
            maxY: Math.max(...ys)
        },
        orientedBox: metrics.orientedBox,
        length: metrics.length,
        width: metrics.width,
        area: metrics.area,
        orientation: metrics.orientation,
        x_um: physCentroid.x,
        y_um: physCentroid.y,
        customTag: 'polygon'
    };
    
    imgObj.flakes.push(newFlake);
    state.drawingPoints = [];
    renderFlakes();
}

// ----------------------------------------------------
// Image Filters and Auto-Segmentation Engine (Flood Fill)
// ----------------------------------------------------
let filteredCanvas = null;

function applyOffscreenFilters() {
    if (!loadedImageEl) return;
    
    if (!filteredCanvas) {
        filteredCanvas = document.createElement('canvas');
    }
    filteredCanvas.width = loadedImageEl.naturalWidth;
    filteredCanvas.height = loadedImageEl.naturalHeight;
    const fctx = filteredCanvas.getContext('2d');
    
    // Draw raw image
    fctx.drawImage(loadedImageEl, 0, 0);
    
    // Apply contrast / brightness / threshold filters in canvas
    const imgData = fctx.getImageData(0, 0, filteredCanvas.width, filteredCanvas.height);
    const data = imgData.data;
    
    const contrast = state.filters.contrast; // e.g. 1.2
    const brightness = (state.filters.brightness - 1.0) * 255; // e.g. -20 to +20
    const threshold = state.filters.threshold;
    const showBinary = state.filters.showBinary;
    
    // Fast pixel processing loop
    for (let i = 0; i < data.length; i += 4) {
        // Red, Green, Blue
        let r = data[i];
        let g = data[i+1];
        let b = data[i+2];
        
        // 1. Contrast adjustment
        r = (r - 128) * contrast + 128;
        g = (g - 128) * contrast + 128;
        b = (b - 128) * contrast + 128;
        
        // 2. Brightness adjustment
        r += brightness;
        g += brightness;
        b += brightness;
        
        // Clamping
        r = Math.max(0, Math.min(255, r));
        g = Math.max(0, Math.min(255, g));
        b = Math.max(0, Math.min(255, b));
        
        if (showBinary) {
            // Convert to grayscale for thresholding display
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;
            const binary = gray >= threshold ? 255 : 0;
            data[i] = binary;
            data[i+1] = binary;
            data[i+2] = binary;
        } else {
            data[i] = r;
            data[i+1] = g;
            data[i+2] = b;
        }
    }
    
    fctx.putImageData(imgData, 0, 0);
}

function _taintedGuard() {
    if (state.canvasTainted) {
        showToast('⚠ Pixel access blocked — open via local server: python -m http.server 8123', 'error');
        return true;
    }
    return false;
}

function runAutoSegmentation(seedPoint) {
    if (_taintedGuard()) return;
    if (!loadedImageEl) return;

    // Bug fix #10: reject seed points that land inside a user-defined ignore area.
    const inIgnored = state.ignoreAreas.some(a =>
        seedPoint.x >= a.minX && seedPoint.x <= a.maxX &&
        seedPoint.y >= a.minY && seedPoint.y <= a.maxY
    );
    if (inIgnored) {
        showToast("Click is inside an Ignore Area — move the seed point outside it", "warning");
        return;
    }

    pushToUndoStack();
    
    const w = offscreenCanvas.width;
    const h = offscreenCanvas.height;
    
    const fctx = offscreenCanvas.getContext('2d');
    const imgData = fctx.getImageData(0, 0, w, h);
    const rawData = imgData.data;
    
    const contrast = state.filters.contrast;
    const brightness = (state.filters.brightness - 1.0) * 255;
    const threshold = state.filters.threshold;
    const tolerance = state.filters.tolerance;
    
    const getAdjustedPixel = (pIdx) => {
        let r = rawData[pIdx];
        let g = rawData[pIdx+1];
        let b = rawData[pIdx+2];
        
        r = (r - 128) * contrast + 128 + brightness;
        g = (g - 128) * contrast + 128 + brightness;
        b = (b - 128) * contrast + 128 + brightness;
        
        return {
            r: Math.max(0, Math.min(255, r)),
            g: Math.max(0, Math.min(255, g)),
            b: Math.max(0, Math.min(255, b))
        };
    };
    
    const bg = state.backgroundRGB || { r: 60, g: 40, b: 110 };
    let abgR = (bg.r - 128) * contrast + 128 + brightness;
    let abgG = (bg.g - 128) * contrast + 128 + brightness;
    let abgB = (bg.b - 128) * contrast + 128 + brightness;
    abgR = Math.max(0, Math.min(255, abgR));
    abgG = Math.max(0, Math.min(255, abgG));
    abgB = Math.max(0, Math.min(255, abgB));
    const bgY = 0.299 * abgR + 0.587 * abgG + 0.114 * abgB;
    
    // Supports 'grayscale' and 'colorDist' detection modes.
    const isFlakePixel = (r, g, b, pixelIndex) => {
        if (state.filters.colorMode === 'colorDist') {
            const d = Math.sqrt((r - abgR)**2 + (g - abgG)**2 + (b - abgB)**2);
            return d >= state.filters.colorDistThreshold;
        }
        const grayVal = 0.299 * r + 0.587 * g + 0.114 * b;
        if (bgY < 128) return grayVal > threshold;
        return grayVal < threshold;
    };

    const seedIdx = (seedPoint.y * w + seedPoint.x) * 4;
    const seedPixelIndex = seedPoint.y * w + seedPoint.x;
    const seedPx = getAdjustedPixel(seedIdx);
    const seedGray = 0.299 * seedPx.r + 0.587 * seedPx.g + 0.114 * seedPx.b;

    if (!isFlakePixel(seedPx.r, seedPx.g, seedPx.b, seedPixelIndex)) {
        showToast("Auto-segment failed: Click missed the flake (does not pass threshold / color distance)", "warning");
        return;
    }
    
    const visited = new Uint8Array(w * h);
    visited[seedPoint.y * w + seedPoint.x] = 1;
    const queue = [seedPoint.x, seedPoint.y];
    
    const segmentPixels = [];
    const maxSegmentSize = 80000;
    
    let head = 0;
    while(head < queue.length && segmentPixels.length < maxSegmentSize) {
        const cx = queue[head++];
        const cy = queue[head++];
        
        segmentPixels.push({ x: cx, y: cy });
        
        const neighbors = [
            { x: cx+1, y: cy },
            { x: cx-1, y: cy },
            { x: cx, y: cy+1 },
            { x: cx, y: cy-1 }
        ];
        
        for(let i=0; i<neighbors.length; i++) {
            const n = neighbors[i];
            if (n.x >= 0 && n.x < w && n.y >= 0 && n.y < h) {
                const nIdx = n.y * w + n.x;
                if (!visited[nIdx]) {
                    const npIdx = nIdx * 4;
                    const nPx = getAdjustedPixel(npIdx);
                    const nGray = 0.299 * nPx.r + 0.587 * nPx.g + 0.114 * nPx.b;
                    // In colorDist mode use RGB distance from seed; in grayscale use luminance delta.
                    const colorDist = (state.filters.colorMode === 'colorDist')
                        ? Math.sqrt((nPx.r - seedPx.r)**2 + (nPx.g - seedPx.g)**2 + (nPx.b - seedPx.b)**2)
                        : Math.abs(nGray - seedGray);
                    if (isFlakePixel(nPx.r, nPx.g, nPx.b, nIdx) && colorDist <= tolerance) {
                        visited[nIdx] = 1;
                        queue.push(n.x, n.y);
                    }
                }
            }
        }
    }

    if (segmentPixels.length < 15) {
        showToast("Auto-segment failed: Region too small", "warning");
        return;
    }
    
    // We have the set of pixel coordinates! We can calculate centroid and oriented box
    // mathematically using algebraic moments of discrete pixels!
    const M00 = segmentPixels.length;
    let sumX = 0, sumY = 0;
    let sumXX = 0, sumYY = 0, sumXY = 0;
    
    let minX = w, maxX = 0;
    let minY = h, maxY = 0;
    
    segmentPixels.forEach(p => {
        sumX += p.x;
        sumY += p.y;
        sumXX += p.x * p.x;
        sumYY += p.y * p.y;
        sumXY += p.x * p.y;
        
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    });
    
    const cx = sumX / M00;
    const cy = sumY / M00;
    
    // Central Moments
    const mu20 = sumXX - cx * sumX;
    const mu02 = sumYY - cy * sumY;
    const mu11 = sumXY - cx * sumY;
    
    const theta = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    
    // Project all points to find the minimum/maximum bounds along major/minor axes
    let minU = Infinity, maxU = -Infinity;
    let minV = Infinity, maxV = -Infinity;
    
    // To speed up OBB on huge lists, scan boundary pixels only or downsample,
    // but doing 50k points in JS takes only ~2ms!
    segmentPixels.forEach(p => {
        const u = (p.x - cx) * cosT + (p.y - cy) * sinT;
        const v = -(p.x - cx) * sinT + (p.y - cy) * cosT;
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
    });
    
    const lengthPx = maxU - minU;
    const widthPx = maxV - minV;
    
    const orientedBox = [
        { u: minU, v: minV },
        { u: maxU, v: minV },
        { u: maxU, v: maxV },
        { u: minU, v: maxV }
    ].map(uv => {
        return {
            x: cx + uv.u * cosT - uv.v * sinT,
            y: cy + uv.u * sinT + uv.v * cosT
        };
    });
    
    // Simplify contour for visual drawing to save memory & render speed
    // We can generate a polygon out of the boundary. For beautiful displays, 
    // we'll keep a downsampled boundary or just render the oriented box!
    // Let's extract simple contour points (e.g. 30 outer shell points) for representation
    const boundaryPoints = extractOuterBoundary(segmentPixels, 32);
    
    const length = lengthPx / state.scaleRatio;
    const width = widthPx / state.scaleRatio;
    const area = M00 / (state.scaleRatio**2);
    const physCentroid = pixelToPhysical(cx, cy);
    
    // Compute average color of the flake pixels to classify thickness based on background contrast
    let totalR = 0, totalG = 0, totalB = 0;
    segmentPixels.forEach(p => {
        const pIdx = (p.y * w + p.x) * 4;
        totalR += rawData[pIdx];
        totalG += rawData[pIdx+1];
        totalB += rawData[pIdx+2];
    });
    const avgR = totalR / segmentPixels.length;
    const avgG = totalG / segmentPixels.length;
    const avgB = totalB / segmentPixels.length;
    
    const classResult = classifyFlakeThickness(avgR, avgG, avgB);
    
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj) return;
    
    const newFlake = {
        id: `flake_${Date.now()}`,
        name: `${imgObj.flakes.length + 1}`,
        color: classResult.color,
        type: 'floodfill',
        points: boundaryPoints, // Visual boundary
        centroid: { x: cx, y: cy },
        boundingBox: { minX, maxX, minY, maxY },
        orientedBox: orientedBox,
        length: Math.max(length, width),
        width: Math.min(length, width),
        area: area,
        orientation: Math.round((theta * 180 / Math.PI) * 10) / 10,
        x_um: physCentroid.x,
        y_um: physCentroid.y,
        customTag: classResult.tag
    };
    
    imgObj.flakes.push(newFlake);
    showToast(`Auto-segmented Flake: ${classResult.tag} (L=${newFlake.length.toFixed(1)}µm, W=${newFlake.width.toFixed(1)}µm)`, 'success');
    renderFlakes();
}

/**
 * Estimate layer thickness from optical contrast (Fresnel-based).
 *
 * Thresholds calibrated from:
 *   Blake et al. 2007, APL 91, 063124  (graphene on 300 nm SiO₂/Si)
 *   Nair et al. 2008, Science 320, 1308
 *   Castellanos-Gomez et al. 2014 (MoS₂ / WS₂ colour contrast)
 *
 * relContrast = |L_flake − L_substrate| / L_substrate
 *   1L   ~ 0.010 – 0.030  (barely visible, near-monolayer graphene)
 *   2L   ~ 0.030 – 0.065
 *   3–5L ~ 0.065 – 0.140
 *   Bulk  > 0.140
 */
function classifyFlakeThickness(flakeR, flakeG, flakeB) {
    if (!state.backgroundRGB) {
        return { tag: 'Thick / Bulk', color: '#f59e0b', layers: -1, relContrast: 1.0 };
    }

    const bg = state.backgroundRGB;
    const flakeY = 0.299 * flakeR + 0.587 * flakeG + 0.114 * flakeB;
    const bgY    = 0.299 * bg.r   + 0.587 * bg.g   + 0.114 * bg.b;
    const deltaY    = Math.abs(flakeY - bgY);
    const colorDist = Math.sqrt((flakeR - bg.r)**2 + (flakeG - bg.g)**2 + (flakeB - bg.b)**2);
    // Michelson-style optical contrast referenced to substrate luminance
    const relContrast = deltaY / (bgY + 1);

    let tag, color, layers;

    if (relContrast < 0.030 && colorDist < 22) {
        tag = 'Monolayer (1L)';    color = '#06b6d4'; layers = 1;
    } else if (relContrast < 0.065 && colorDist < 45) {
        tag = 'Bilayer (2L)';      color = '#22d3ee'; layers = 2;
    } else if (relContrast < 0.140) {
        tag = 'Few-Layer (3–5L)';  color = '#10b981'; layers = 3;
    } else {
        tag = 'Thick / Bulk';      color = '#f59e0b'; layers = -1;
    }

    return { tag, color, layers, relContrast, deltaY, colorDist };
}

function autoDetectAllFlakes() {
    if (!loadedImageEl) return;
    if (_taintedGuard()) return;
    pushToUndoStack();

    setDetectProgress(0, 'Initialising…');
    showToast("Scanning substrate for flakes...", "info");

    // Defer actual work one frame so the progress bar renders first
    setTimeout(() => _autoDetectAllFlakesCore(), 20);
}

function _autoDetectAllFlakesCore() {
    const w = offscreenCanvas.width;
    const h = offscreenCanvas.height;
    
    const fctx = offscreenCanvas.getContext('2d');
    const imgData = fctx.getImageData(0, 0, w, h);
    const rawData = imgData.data;
    
    const contrast = state.filters.contrast;
    const brightness = (state.filters.brightness - 1.0) * 255;
    const threshold = state.filters.threshold;
    const tolerance = state.filters.tolerance;
    const visited = new Uint8Array(w * h);
    
    const getAdjustedPixel = (pIdx) => {
        let r = rawData[pIdx];
        let g = rawData[pIdx+1];
        let b = rawData[pIdx+2];
        
        r = (r - 128) * contrast + 128 + brightness;
        g = (g - 128) * contrast + 128 + brightness;
        b = (b - 128) * contrast + 128 + brightness;
        
        return {
            r: Math.max(0, Math.min(255, r)),
            g: Math.max(0, Math.min(255, g)),
            b: Math.max(0, Math.min(255, b))
        };
    };
    
    const bg = state.backgroundRGB || { r: 60, g: 40, b: 110 };
    let abgR = (bg.r - 128) * contrast + 128 + brightness;
    let abgG = (bg.g - 128) * contrast + 128 + brightness;
    let abgB = (bg.b - 128) * contrast + 128 + brightness;
    abgR = Math.max(0, Math.min(255, abgR));
    abgG = Math.max(0, Math.min(255, abgG));
    abgB = Math.max(0, Math.min(255, abgB));
    const bgY = 0.299 * abgR + 0.587 * abgG + 0.114 * abgB;
    
    // Shared detection predicate — supports grayscale and colorDist modes.
    const isFlakePixel = (r, g, b, pixelIndex) => {
        if (state.filters.colorMode === 'colorDist') {
            const d = Math.sqrt((r - abgR)**2 + (g - abgG)**2 + (b - abgB)**2);
            return d >= state.filters.colorDistThreshold;
        }
        const grayVal = 0.299 * r + 0.587 * g + 0.114 * b;
        if (bgY < 128) return grayVal > threshold;
        return grayVal < threshold;
    };

    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj) { hideDetectProgress(); return; }

    // Clear existing flakes to prevent overlaying duplicates
    imgObj.flakes = [];

    let detectedCount = 0;

    // Morphological cleanup — build an eroded mask to exclude isolated noise pixels
    let erodedMask = null;
    if (state.filters.morphCleanup) {
        setDetectProgress(5, 'Morphological cleanup…');
        // Pass getAdjustedPixel so the mask uses the same adjusted values as the main scan loop
        erodedMask = buildErodedMask(isFlakePixel, getAdjustedPixel, rawData, w, h, state.filters.erosionKernel);
        setDetectProgress(20, 'Scanning…');
    }

    // Scan image in a fast grid pattern (3px steps) to find unvisited dark/contrasting flake seeds
    const stepX = 3;
    const stepY = 3;

    // If no scale-bar ignore area exists yet, auto-detect and register one now
    const hasScaleBarArea = state.ignoreAreas.some(a => a.isScaleBar);
    if (state.filters.ignoreBanner && !hasScaleBarArea) {
        const scaleBar = autoDetectScaleBar();
        if (scaleBar) {
            _registerScaleBarIgnoreArea(scaleBar);
        }
    }

    // Fallback: if ignoreBanner is on and still no scale-bar area, limit scan height
    const scanHeightLimit = (state.filters.ignoreBanner && !state.ignoreAreas.some(a => a.isScaleBar))
        ? Math.round(h * 0.90)
        : h - stepY;

    const totalRows = Math.ceil((scanHeightLimit - stepY) / stepY);
    let rowsDone = 0;

    for (let y = stepY; y < scanHeightLimit; y += stepY) {
        rowsDone++;
        if (rowsDone % 20 === 0) {
            const pct = state.filters.morphCleanup
                ? 20 + Math.round((rowsDone / totalRows) * 75)
                : Math.round((rowsDone / totalRows) * 90);
            setDetectProgress(pct, `Scanning row ${rowsDone}/${totalRows}…`);
        }
        for (let x = stepX; x < w - stepX; x += stepX) {
            // Ignore custom defined ignore areas (includes scale bar region if registered)
            let insideIgnoreArea = false;
            if (state.ignoreAreas && state.ignoreAreas.length > 0) {
                for (let i = 0; i < state.ignoreAreas.length; i++) {
                    const area = state.ignoreAreas[i];
                    if (x >= area.minX && x <= area.maxX && y >= area.minY && y <= area.maxY) {
                        insideIgnoreArea = true;
                        break;
                    }
                }
            }
            if (insideIgnoreArea) {
                continue;
            }
            
            const idx = y * w + x;
            if (visited[idx]) continue;
            
            // Bug fix: erodedMask guard moved before getAdjustedPixel to avoid wasted computation.
            // Also removed the unused 'gray' variable that was computed every pixel but never read.
            if (erodedMask && !erodedMask[idx]) continue;

            const pIdx = idx * 4;
            const px = getAdjustedPixel(pIdx);

            // Noise gate: Must have some color contrast relative to background to be a flake seed.
            // In colorDist mode, isFlakePixel already enforces the distance threshold.
            // In grayscale mode, add a secondary colorDistFromBg > 6 guard to skip near-background noise.
            const colorDistFromBg = Math.sqrt((px.r - abgR)**2 + (px.g - abgG)**2 + (px.b - abgB)**2);

            const passesSeed = (state.filters.colorMode === 'colorDist')
                ? isFlakePixel(px.r, px.g, px.b, idx)
                : (colorDistFromBg > 6 && isFlakePixel(px.r, px.g, px.b, idx));

            if (passesSeed) {
                // Run local flood fill
                visited[idx] = 1;
                const segmentPixels = [];
                const queue = [x, y];
                let head = 0;
                
                const targetR = px.r;
                const targetG = px.g;
                const targetB = px.b;
                // Bug fix #7: pre-compute seed grey for tolerance gating.
                const seedGrayLocal = 0.299 * targetR + 0.587 * targetG + 0.114 * targetB;

                while (head < queue.length && segmentPixels.length < 80000) {
                    const cx = queue[head++];
                    const cy = queue[head++];

                    segmentPixels.push({ x: cx, y: cy });

                    const neighbors = [
                        { x: cx+1, y: cy },
                        { x: cx-1, y: cy },
                        { x: cx, y: cy+1 },
                        { x: cx, y: cy-1 }
                    ];

                    for (let i = 0; i < neighbors.length; i++) {
                        const n = neighbors[i];
                        if (n.x >= 0 && n.x < w && n.y >= 0 && n.y < h) {
                            const nNeighborIdx = n.y * w + n.x;
                            if (!visited[nNeighborIdx]) {
                                const npIdx = nNeighborIdx * 4;
                                const nPx = getAdjustedPixel(npIdx);
                                const nGray = 0.299 * nPx.r + 0.587 * nPx.g + 0.114 * nPx.b;
                                // In colorDist mode use RGB distance from seed; in grayscale use luminance delta.
                                const nColorDist = (state.filters.colorMode === 'colorDist')
                                    ? Math.sqrt((nPx.r - targetR)**2 + (nPx.g - targetG)**2 + (nPx.b - targetB)**2)
                                    : Math.abs(nGray - seedGrayLocal);
                                if (isFlakePixel(nPx.r, nPx.g, nPx.b, nNeighborIdx) && nColorDist <= tolerance) {
                                    visited[nNeighborIdx] = 1;
                                    queue.push(n.x, n.y);
                                }
                            }
                        }
                    }
                }
                
                // Keep the flake if it's within a valid physical size range based on Min Flake Size slider
                if (segmentPixels.length >= state.filters.minSize && segmentPixels.length <= 500000) {
                    const M00 = segmentPixels.length;
                    let sumX = 0, sumY = 0;
                    let sumXX = 0, sumYY = 0, sumXY = 0;
                    
                    let minX = w, maxX = 0;
                    let minY = h, maxY = 0;
                    
                    segmentPixels.forEach(p => {
                        sumX += p.x;
                        sumY += p.y;
                        sumXX += p.x * p.x;
                        sumYY += p.y * p.y;
                        sumXY += p.x * p.y;
                        
                        if (p.x < minX) minX = p.x;
                        if (p.x > maxX) maxX = p.x;
                        if (p.y < minY) minY = p.y;
                        if (p.y > maxY) maxY = p.y;
                    });
                    
                    const cx = sumX / M00;
                    const cy = sumY / M00;
                    
                    const mu20 = sumXX - cx * sumX;
                    const mu02 = sumYY - cy * sumY;
                    const mu11 = sumXY - cx * sumY;
                    
                    const theta = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
                    const cosT = Math.cos(theta);
                    const sinT = Math.sin(theta);
                    
                    let minU = Infinity, maxU = -Infinity;
                    let minV = Infinity, maxV = -Infinity;
                    
                    segmentPixels.forEach(p => {
                        const u = (p.x - cx) * cosT + (p.y - cy) * sinT;
                        const v = -(p.x - cx) * sinT + (p.y - cy) * cosT;
                        if (u < minU) minU = u;
                        if (u > maxU) maxU = u;
                        if (v < minV) minV = v;
                        if (v > maxV) maxV = v;
                    });
                    
                    const lengthPx = maxU - minU;
                    const widthPx = maxV - minV;
                    
                    const orientedBox = [
                        { u: minU, v: minV },
                        { u: maxU, v: minV },
                        { u: maxU, v: maxV },
                        { u: minU, v: maxV }
                    ].map(uv => {
                        return {
                            x: cx + uv.u * cosT - uv.v * sinT,
                            y: cy + uv.u * sinT + uv.v * cosT
                        };
                    });
                    
                    const boundaryPoints = extractOuterBoundary(segmentPixels, 32);
                    const length = lengthPx / state.scaleRatio;
                    const width = widthPx / state.scaleRatio;
                    const area = M00 / (state.scaleRatio**2);
                    const physCentroid = pixelToPhysical(cx, cy);
                    
                    // Compute average color of the flake pixels to classify thickness based on background contrast
                    let totalR = 0, totalG = 0, totalB = 0;
                    segmentPixels.forEach(p => {
                        const pIdx = (p.y * w + p.x) * 4;
                        totalR += rawData[pIdx];
                        totalG += rawData[pIdx+1];
                        totalB += rawData[pIdx+2];
                    });
                    const avgR = totalR / segmentPixels.length;
                    const avgG = totalG / segmentPixels.length;
                    const avgB = totalB / segmentPixels.length;
                    
                    const classResult = classifyFlakeThickness(avgR, avgG, avgB);
                    
                    // Check if centroid falls inside any custom ignore areas
                    let centroidIgnored = false;
                    if (state.ignoreAreas && state.ignoreAreas.length > 0) {
                        for (let i = 0; i < state.ignoreAreas.length; i++) {
                            const area = state.ignoreAreas[i];
                            if (cx >= area.minX && cx <= area.maxX && cy >= area.minY && cy <= area.maxY) {
                                centroidIgnored = true;
                                break;
                            }
                        }
                    }
                    if (centroidIgnored) {
                        continue;
                    }
                    
                    detectedCount++;
                    
                    const newFlake = {
                        id: `flake_${Date.now()}_${detectedCount}`,
                        name: `${detectedCount}`,
                        color: classResult.color,
                        type: 'floodfill',
                        points: boundaryPoints,
                        centroid: { x: cx, y: cy },
                        boundingBox: { minX, maxX, minY, maxY },
                        orientedBox: orientedBox,
                        length: Math.max(length, width),
                        width: Math.min(length, width),
                        area: area,
                        orientation: Math.round((theta * 180 / Math.PI) * 10) / 10,
                        x_um: physCentroid.x,
                        y_um: physCentroid.y,
                        customTag: classResult.tag,
                        layers: classResult.layers,
                        relContrast: classResult.relContrast,
                        notes: ''
                    };
                    
                    imgObj.flakes.push(newFlake);
                }
            }
        }
    }
    
    // Watershed blob splitting (optional)
    if (state.filters.watershedSplit && imgObj.flakes.length > 0) {
        setDetectProgress(93, 'Watershed splitting…');
        applyWatershedSplit(imgObj, rawData, w, h);
        detectedCount = imgObj.flakes.length;
    }

    setDetectProgress(100, `Found ${detectedCount} flake${detectedCount !== 1 ? 's' : ''}`);
    setTimeout(hideDetectProgress, 1800);

    if (detectedCount > 0) {
        showToast(`Auto-detected ${detectedCount} flakes!`, 'success');
    } else {
        showToast("No flakes found. Try adjusting contrast/threshold/tolerance sliders.", 'warning');
    }

    renderFlakes();
    redraw();
}

// Helper functions for Douglas-Peucker simplification
function distanceToLine(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx === 0 && dy === 0) {
        return Math.sqrt((p.x - a.x)**2 + (p.y - a.y)**2);
    }
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx*dx + dy*dy);
    const clampedT = Math.max(0, Math.min(1, t));
    const projX = a.x + clampedT * dx;
    const projY = a.y + clampedT * dy;
    return Math.sqrt((p.x - projX)**2 + (p.y - projY)**2);
}

function douglasPeucker(points, epsilon) {
    if (points.length <= 2) return points;
    
    let maxDist = 0;
    let index = 0;
    const end = points.length - 1;
    
    for (let i = 1; i < end; i++) {
        const dist = distanceToLine(points[i], points[0], points[end]);
        if (dist > maxDist) {
            maxDist = dist;
            index = i;
        }
    }
    
    if (maxDist > epsilon) {
        const results1 = douglasPeucker(points.slice(0, index + 1), epsilon);
        const results2 = douglasPeucker(points.slice(index), epsilon);
        return results1.slice(0, results1.length - 1).concat(results2);
    } else {
        return [points[0], points[end]];
    }
}

// Trace boundary points of segment to draw outlines quickly
function extractOuterBoundary(pixels, countLimit) {
    if (pixels.length === 0) return [];
    if (pixels.length <= 2) return pixels;
    
    // Create grid for O(1) lookup
    const grid = {};
    pixels.forEach(p => {
        if (!grid[p.y]) grid[p.y] = {};
        grid[p.y][p.x] = true;
    });
    
    const inside = (x, y) => {
        return grid[y] && grid[y][x];
    };
    
    // Find starting pixel (top-leftmost boundary pixel)
    let start = pixels[0];
    pixels.forEach(p => {
        if (p.y < start.y || (p.y === start.y && p.x < start.x)) {
            start = p;
        }
    });
    
    const contour = [];
    let currX = start.x;
    let currY = start.y;
    
    // 8-neighbor direction offsets in clockwise order:
    // 0: Up-Left, 1: Up, 2: Up-Right, 3: Right, 4: Down-Right, 5: Down, 6: Down-Left, 7: Left
    const dx = [-1,  0,  1, 1, 1, 0, -1, -1];
    const dy = [-1, -1, -1, 0, 1, 1,  1,  0];
    
    // Backtrack pixel is initially directly above the start pixel (guaranteed outside)
    let bx = start.x;
    let by = start.y - 1;
    
    let visitedCount = 0;
    const maxIterations = pixels.length * 2 + 100;
    
    do {
        // Find index of backtrack pixel relative to curr
        let bDir = 0;
        for (let d = 0; d < 8; d++) {
            if (currX + dx[d] === bx && currY + dy[d] === by) {
                bDir = d;
                break;
            }
        }
        
        // Scan clockwise starting from backtrack pixel
        let foundNext = false;
        let nextX = currX;
        let nextY = currY;
        
        for (let i = 0; i < 8; i++) {
            const checkDir = (bDir + i) % 8;
            const nx = currX + dx[checkDir];
            const ny = currY + dy[checkDir];
            if (inside(nx, ny)) {
                nextX = nx;
                nextY = ny;
                // Backtrack pixel for the next step is the pixel scanned just before the one we found
                const prevDir = (checkDir + 7) % 8;
                bx = currX + dx[prevDir];
                by = currY + dy[prevDir];
                foundNext = true;
                break;
            }
        }
        
        if (!foundNext) {
            // Isolated pixel
            contour.push({ x: currX, y: currY });
            break;
        }
        
        contour.push({ x: currX, y: currY });
        currX = nextX;
        currY = nextY;
        
        visitedCount++;
        if (visitedCount > maxIterations) {
            break;
        }
    } while (currX !== start.x || currY !== start.y);
    
    if (contour.length <= 4) {
        return contour;
    }
    
    // Simplify closed loop using Douglas-Peucker algorithm
    const closedContour = [...contour, contour[0]];
    const simplified = douglasPeucker(closedContour, 1.2);
    if (simplified.length > 1) {
        simplified.pop();
    }
    
    if (simplified.length <= countLimit) {
        return simplified;
    }
    
    // Downsample sequentially along the perimeter
    const step = Math.ceil(simplified.length / countLimit);
    const finalPts = [];
    for (let i = 0; i < simplified.length; i += step) {
        finalPts.push(simplified[i]);
    }
    return finalPts;
}

// ----------------------------------------------------
// Drawing & Canvas Render Loop
// ----------------------------------------------------

function redraw() {
    if (!canvas || !ctx) return;
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (!loadedImageEl) {
        ctx.save();
        ctx.fillStyle = '#9ca3af';
        ctx.font = '16px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('No Substrate Images Loaded. Click "+" in the Library to start.', canvas.width / 2, canvas.height / 2);
        ctx.restore();
        return;
    }
    
    ctx.save();
    
    // Apply viewport translations (Pan & Zoom)
    ctx.translate(state.pan.x, state.pan.y);
    ctx.scale(state.zoom, state.zoom);
    
    // 1. Draw all images at their offset locations
    state.images.forEach(img => {
        ctx.save();
        const ox = img.offset ? img.offset.x : 0;
        const oy = img.offset ? img.offset.y : 0;
        ctx.translate(ox, oy);
        if (img.id === state.activeImageId && state.filters.showBinary && filteredCanvas) {
            ctx.drawImage(filteredCanvas, 0, 0);
        } else if (img.imageEl) {
            ctx.drawImage(img.imageEl, 0, 0);
        }
        ctx.restore();
    });
    
    // 2. Render coordinate grid overlay (Faint grey lines in microns)
    drawCoordinateGrid();
    
    // 3. Draw origin and flakes for all images
    state.images.forEach(img => {
        if (img.origin) {
            const offset = img.offset || { x: 0, y: 0 };
            drawOriginMarkerOnCtx(ctx, state.zoom, img.origin, offset);
        }
        drawFlakesForImage(img, ctx, state.zoom, state.filters.showLabels);
    });
    
    // Draw user-defined ignore areas
    drawIgnoreAreas();

    // Bug fix #9: render scale bar highlight via state so it survives mouse-move redraws.
    if (state.highlightScaleBar && Date.now() < state.highlightScaleBar.expiresAt) {
        const h = state.highlightScaleBar;
        const activeImg = state.images.find(img => img.id === state.activeImageId);
        const offset = activeImg ? (activeImg.offset || { x: 0, y: 0 }) : { x: 0, y: 0 };
        ctx.save();
        ctx.translate(offset.x, offset.y);
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 4 / state.zoom;
        ctx.strokeRect(h.startX - 5, h.y - 10, h.length + 10, 20);
        ctx.restore();
    }

    // 4. Draw matrix grid overlay if enabled
    if (state.gridLayout.enabled && state.gridLayout.showLines) {
        drawGridOverlay();
    }

    // 5. Draw active drawing guides (e.g. vertices of in-progress polygon)
    drawActiveDrawingPoints();
    
    ctx.restore();
}

function drawCoordinateGrid() {
    const activeImg = state.images.find(img => img.id === state.activeImageId);
    if (!activeImg) return;
    
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1 / state.zoom;
    
    const w = activeImg.width;
    const h = activeImg.height;
    const ox = activeImg.origin.x;
    const oy = activeImg.origin.y;
    const offset = activeImg.offset || { x: 0, y: 0 };
    
    // Draw grid lines every 50 µm
    const stepPhys = 50; // µm
    const stepPx = stepPhys * state.scaleRatio;
    
    ctx.translate(offset.x, offset.y);
    
    // Vertical grid lines
    let startX = ox % stepPx;
    for (let x = startX; x < w; x += stepPx) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
    }
    
    // Horizontal grid lines
    let startY = oy % stepPx;
    for (let y = startY; y < h; y += stepPx) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
    }
    
    ctx.restore();
}

function drawOriginMarkerOnCtx(ctx, zoom, origin, offset) {
    ctx.save();
    ctx.translate(offset.x, offset.y);
    
    // Bug fix #1: canvas 2D API does not resolve CSS custom properties — use literal hex.
    ctx.strokeStyle = '#06b6d4';
    ctx.fillStyle = 'rgba(6, 182, 212, 0.2)';
    ctx.lineWidth = 3 / zoom;

    const ox = origin.x;
    const oy = origin.y;

    ctx.beginPath();
    ctx.arc(ox, oy, 12 / zoom, 0, Math.PI*2);
    ctx.stroke();
    ctx.fill();

    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.moveTo(ox - 24 / zoom, oy);
    ctx.lineTo(ox + 24 / zoom, oy);
    ctx.moveTo(ox, oy - 24 / zoom);
    ctx.lineTo(ox, oy + 24 / zoom);
    ctx.stroke();

    ctx.fillStyle = '#22d3ee';
    ctx.font = `${Math.max(10, 12 / zoom)}px Fira Code`;
    ctx.fillText("ORIGIN (0, 0)", ox + 15 / zoom, oy - 8 / zoom);
    
    ctx.restore();
}

function drawOriginMarker() {
    const activeImg = state.images.find(img => img.id === state.activeImageId);
    const offset = activeImg ? (activeImg.offset || { x: 0, y: 0 }) : { x: 0, y: 0 };
    drawOriginMarkerOnCtx(ctx, state.zoom, state.origin, offset);
}

function drawFlakesForImage(imgObj, ctx, zoom, forceDrawLabels = false) {
    if (!imgObj.flakes) return;

    // Accumulated label rects for overlap resolution (image-pixel coords)
    const _pendingLabels = []; // { cx, cy, nameStr, dimStr, color, naturalY }
    const _placedRects   = []; // { x0, y0, x1, y1 } already-committed label boxes

    imgObj.flakes.forEach(flake => {
        const isHovered = (flake.id === state.hoveredFlakeId);
        const isSelected = (flake.id === state.selectedFlakeId);
        
        ctx.save();
        const ox = imgObj.offset ? imgObj.offset.x : 0;
        const oy = imgObj.offset ? imgObj.offset.y : 0;
        ctx.translate(ox, oy);
        
        ctx.strokeStyle = flake.color;
        ctx.fillStyle = isHovered ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = (isSelected ? 4 : isHovered ? 3 : 2) / zoom;
        
        if (flake.type === 'box') {
            const p1 = flake.points[0];
            const p2 = flake.points[1];
            ctx.beginPath();
            ctx.rect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
            ctx.stroke();
            ctx.fill();
        } else if (flake.points && flake.points.length > 0) {
            ctx.beginPath();
            ctx.moveTo(flake.points[0].x, flake.points[0].y);
            for (let i = 1; i < flake.points.length; i++) {
                ctx.lineTo(flake.points[i].x, flake.points[i].y);
            }
            ctx.closePath();
            ctx.stroke();
            ctx.fill();
        }
        
        // Per-flake colours (colormap assigns three distinct hues per flake)
        const col    = flake.color    || '#f59e0b';
        const colDim = flake.dimColor || col;   // L×W dim string
        const colArm = flake.armColor || col;   // length & width arm labels + lines
        const hexToRgba = (hex, a) => {
            const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
            return `rgba(${r},${g},${b},${a})`;
        };

        if (flake.orientedBox && flake.orientedBox.length === 4) {
            ctx.strokeStyle = isHovered ? hexToRgba(col, 0.9) : hexToRgba(col, 0.45);
            ctx.setLineDash([4 / zoom, 4 / zoom]);
            ctx.lineWidth = 1 / zoom;
            ctx.beginPath();
            ctx.moveTo(flake.orientedBox[0].x, flake.orientedBox[0].y);
            for (let i = 1; i < 4; i++) {
                ctx.lineTo(flake.orientedBox[i].x, flake.orientedBox[i].y);
            }
            ctx.closePath();
            ctx.stroke();
            ctx.setLineDash([]);
        }

        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5 / zoom;
        ctx.beginPath();
        const cx = flake.centroid.x;
        const cy = flake.centroid.y;
        const crossSize = 6 / zoom;
        ctx.moveTo(cx - crossSize, cy);
        ctx.lineTo(cx + crossSize, cy);
        ctx.moveTo(cx, cy - crossSize);
        ctx.lineTo(cx, cy + crossSize);
        ctx.stroke();

        // Draw dimension crosshairs if option is checked
        if (state.filters.showCrosshairs && flake.orientedBox && flake.orientedBox.length === 4) {
            ctx.save();
            ctx.strokeStyle = hexToRgba(col, 0.85);
            ctx.setLineDash([3 / zoom, 3 / zoom]);
            ctx.lineWidth = 1.5 / zoom;

            const m1 = {
                x: (flake.orientedBox[0].x + flake.orientedBox[1].x) / 2,
                y: (flake.orientedBox[0].y + flake.orientedBox[1].y) / 2
            };
            const m2 = {
                x: (flake.orientedBox[2].x + flake.orientedBox[3].x) / 2,
                y: (flake.orientedBox[2].y + flake.orientedBox[3].y) / 2
            };
            const m3 = {
                x: (flake.orientedBox[1].x + flake.orientedBox[2].x) / 2,
                y: (flake.orientedBox[1].y + flake.orientedBox[2].y) / 2
            };
            const m4 = {
                x: (flake.orientedBox[3].x + flake.orientedBox[0].x) / 2,
                y: (flake.orientedBox[3].y + flake.orientedBox[0].y) / 2
            };

            // Both arms — same colArm colour
            ctx.strokeStyle = colArm;
            ctx.beginPath();
            ctx.moveTo(m3.x, m3.y);
            ctx.lineTo(m4.x, m4.y);
            ctx.moveTo(m1.x, m1.y);
            ctx.lineTo(m2.x, m2.y);
            ctx.stroke();

            ctx.restore();

            // ── Dimension labels on crosshair midpoints ──
            ctx.save();
            const center = { x: (m1.x + m2.x) / 2, y: (m1.y + m2.y) / 2 };
            const lMidX = (m3.x + center.x) / 2, lMidY = (m3.y + center.y) / 2;
            const wMidX = (m1.x + center.x) / 2, wMidY = (m1.y + center.y) / 2;

            // Arm lengths in image-pixel space — font scales with them
            const lenArmPx = Math.hypot(m3.x - center.x, m3.y - center.y);
            const widArmPx = Math.hypot(m1.x - center.x, m1.y - center.y);

            // Adaptive arm label:
            // 1. Skip entirely if the arm is shorter than 30 screen pixels
            //    (avoids clutter on tiny flakes at low zoom).
            // 2. Measure the text at a trial font size, then scale it so the
            //    text fills ≤ 78% of the arm length — auto-fits any flake size.
            const _armLabel = (text, mx, my, fg, armPx) => {
                if (armPx * zoom < 30) return;   // too short on screen — skip

                // Trial size: 26% of arm length, clamped to reasonable bounds
                let fs = Math.max(7, Math.min(40, armPx * 0.26));
                ctx.font = `500 ${fs}px "Fira Code", monospace`;

                // Measure and shrink if text would overflow 78% of arm
                const targetW = armPx * 0.78;
                const textW   = ctx.measureText(text).width;
                if (textW > targetW) fs *= targetW / textW;

                ctx.font         = `500 ${Math.max(5, fs)}px "Fira Code", monospace`;
                ctx.textAlign    = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle    = fg;
                ctx.fillText(text, mx, my);
            };
            _armLabel(`${flake.length.toFixed(1)} µm`, lMidX, lMidY, colArm, lenArmPx);
            _armLabel(`${flake.width.toFixed(1)} µm`,  wMidX, wMidY, colArm, widArmPx);
            ctx.restore();
        }

        // ── Name + size label — accumulate for overlap-resolved pass ──
        if (isHovered || isSelected || forceDrawLabels) {
            const fs  = Math.max(8, 10 / zoom);
            const fsm = Math.max(6.5, 8 / zoom);
            const nameStr = flake.name;
            const dimStr  = `${flake.length.toFixed(1)} × ${flake.width.toFixed(1)} µm`;
            const gapY = 3 / zoom;
            const ph   = fs + fsm + 3 * gapY;
            let minY = cy;
            if (flake.orientedBox && flake.orientedBox.length === 4) {
                minY = Math.min(...flake.orientedBox.map(p => p.y));
            } else if (flake.points && flake.points.length > 0) {
                minY = Math.min(...flake.points.map(p => p.y));
            }
            const ox = imgObj.offset ? imgObj.offset.x : 0;
            const oy = imgObj.offset ? imgObj.offset.y : 0;
            _pendingLabels.push({
                cx: cx + ox, naturalY: minY + oy - 10 / zoom - ph,
                nameStr, dimStr,
                color: col, dimColor: colDim,
                fs, fsm, gapY, ph
            });
        }

        ctx.restore();
    });

    // ── Pass 2: draw name+dim labels with overlap resolution ──
    if (_pendingLabels.length === 0) return;

    // Measure text widths to get bounding boxes
    ctx.save();
    _pendingLabels.forEach(lbl => {
        ctx.font = `700 ${lbl.fs}px Inter, sans-serif`;
        const wName = ctx.measureText(lbl.nameStr).width;
        ctx.font = `400 ${lbl.fsm}px "Fira Code", monospace`;
        const wDim  = ctx.measureText(lbl.dimStr).width;
        lbl.halfW = Math.max(wName, wDim) / 2 + 2 / zoom;
    });
    ctx.restore();

    // Sort by natural Y so upper labels get priority
    _pendingLabels.sort((a, b) => a.naturalY - b.naturalY);

    _pendingLabels.forEach(lbl => {
        let y = lbl.naturalY;
        // Nudge upward until no overlap with already-placed labels
        for (let iter = 0; iter < 40; iter++) {
            const x0 = lbl.cx - lbl.halfW, x1 = lbl.cx + lbl.halfW;
            const y1 = y + lbl.ph;
            const clash = _placedRects.some(r =>
                x0 < r.x1 && x1 > r.x0 && y < r.y1 && y1 > r.y0
            );
            if (!clash) break;
            y -= lbl.ph + 3 / zoom;
        }
        _placedRects.push({ x0: lbl.cx - lbl.halfW, y0: y, x1: lbl.cx + lbl.halfW, y1: y + lbl.ph });

        // Draw — no strokeText
        ctx.save();
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';

        ctx.font      = `700 ${lbl.fs}px Inter, sans-serif`;
        ctx.fillStyle = lbl.color;
        ctx.fillText(lbl.nameStr, lbl.cx, y + lbl.gapY);

        ctx.font      = `400 ${lbl.fsm}px "Fira Code", monospace`;
        ctx.fillStyle = lbl.dimColor || lbl.color;
        ctx.fillText(lbl.dimStr, lbl.cx, y + 2 * lbl.gapY + lbl.fs);

        ctx.restore();
    });
}

function drawAllFlakes() {
    state.images.forEach(img => {
        drawFlakesForImage(img, ctx, state.zoom, state.filters.showLabels);
    });
}

function drawActiveDrawingPoints() {
    if (state.drawingPoints.length === 0) return;
    
    const activeImg = state.images.find(img => img.id === state.activeImageId);
    const offset = activeImg ? (activeImg.offset || { x: 0, y: 0 }) : { x: 0, y: 0 };
    
    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.fillStyle = 'var(--secondary)';
    
    state.drawingPoints.forEach((p, idx) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 / state.zoom, 0, Math.PI*2);
        ctx.fill();
        
        // Label vertices
        ctx.fillStyle = 'white';
        ctx.font = `${8 / state.zoom}px Fira Code`;
        ctx.fillText(idx + 1, p.x + 6 / state.zoom, p.y - 6 / state.zoom);
    });
    
    ctx.restore();
}

// ----------------------------------------------------
// UI Render Engines (Flakes list, table, substrate list)
// ----------------------------------------------------

function renderFlakes() {
    const listContainer = document.getElementById('flakes-list');
    // data-table was removed from the layout; guard every reference so older
    // cached pages that still have the element don't break.
    const tableBody = document.querySelector('#data-table tbody');

    listContainer.innerHTML = '';
    if (tableBody) tableBody.innerHTML = '';

    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj || imgObj.flakes.length === 0) {
        listContainer.innerHTML = '<div class="info-card" style="text-align:center;">No flakes annotated yet. Use drawing tools or Flood-Fill to start measuring.</div>';
        if (tableBody) tableBody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--text-dim);">No analytical data available</td></tr>';
        updateLiveStats();
        return;
    }

    const PRESET_TAGS = ['Monolayer', 'Bilayer', 'Trilayer', 'Few-Layer', 'Thick Flake', 'Residue'];

    const displayFlakes = getFilteredSortedFlakes(imgObj.flakes);

    if (displayFlakes.length === 0) {
        listContainer.innerHTML = '<div class="info-card" style="text-align:center; font-size:0.72rem; color:var(--text-dim);">No flakes match the search.</div>';
        tableBody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--text-dim);">No match</td></tr>';
        return;
    }

    displayFlakes.forEach(flake => {
        const isSelected = (flake.id === state.selectedFlakeId);
        
        // Build layer badge
        const layerColor = flake.color || '#f59e0b';
        const contrastStr = flake.relContrast != null
            ? `Contrast: ${(flake.relContrast * 100).toFixed(1)}%`
            : '';
        const isPreset = PRESET_TAGS.includes(flake.customTag);

        // --- Sidebar Card ---
        const card = document.createElement('div');
        card.className = `flake-card ${isSelected ? 'active' : ''}`;
        card.setAttribute('data-id', flake.id);
        card.style.setProperty('--flake-accent', layerColor);
        card.innerHTML = `
            <div class="flake-card-header">
                <div class="flake-title" style="display:flex; align-items:center; gap:0.35rem;">
                    <span class="flake-color-swatch" data-flake-id="${flake.id}" title="Click to change annotation colour" style="width:12px; height:12px; border-radius:50%; flex-shrink:0; background-color:${layerColor}; cursor:pointer; display:inline-block; border:1.5px solid rgba(255,255,255,0.25); transition:transform 0.15s, box-shadow 0.15s;"></span>
                    <input type="text" class="flake-name-input" value="${flake.name}" onchange="updateFlakeName('${flake.id}', this.value)" style="background:transparent; border:none; border-bottom:1px dashed var(--border-color); font-weight:700; color:var(--text-primary); font-size:0.75rem; padding:0 0.1rem; width:45px;" onclick="event.stopPropagation()">
                </div>
                <div style="display:flex; align-items:center; gap:0.25rem;" onclick="event.stopPropagation()">
                    <select class="tag-select" style="padding:0.1rem 0.2rem; font-size:0.65rem; width:68px; height:1.4rem; border-radius:4px; background:var(--input-bg); border:1px solid var(--border-color); color:var(--text-primary);" onchange="handleTagSelectChange('${flake.id}', this)" title="${contrastStr}">
                        <option value="Monolayer" ${flake.customTag === 'Monolayer' ? 'selected' : ''}>Monolayer</option>
                        <option value="Bilayer" ${flake.customTag === 'Bilayer' ? 'selected' : ''}>Bilayer</option>
                        <option value="Trilayer" ${flake.customTag === 'Trilayer' ? 'selected' : ''}>Trilayer</option>
                        <option value="Few-Layer" ${flake.customTag === 'Few-Layer' ? 'selected' : ''}>Few-Layer</option>
                        <option value="Thick Flake" ${flake.customTag === 'Thick Flake' ? 'selected' : ''}>Thick Flake</option>
                        <option value="Residue" ${flake.customTag === 'Residue' ? 'selected' : ''}>Residue</option>
                        <option value="custom" ${!isPreset ? 'selected' : ''}>Custom...</option>
                    </select>
                    <input type="text" class="custom-tag-input" value="${flake.customTag}" style="padding:0.1rem 0.25rem; font-size:0.65rem; width:65px; height:1.4rem; display:${!isPreset ? 'inline-block' : 'none'}; border-radius:4px; background:var(--input-bg); border:1px solid var(--border-color); color:var(--text-primary);" onchange="updateFlakeTag('${flake.id}', this.value)">
                </div>
            </div>
            <div class="flake-meta-grid">
                <div class="flake-meta-item">Length: <span>${flake.length.toFixed(2)} µm</span></div>
                <div class="flake-meta-item">Width: <span>${flake.width.toFixed(2)} µm</span></div>
                <div class="flake-meta-item">X: <span>${flake.x_um.toFixed(2)} µm</span></div>
                <div class="flake-meta-item">Y: <span>${flake.y_um.toFixed(2)} µm</span></div>
                <div class="flake-meta-item">Area: <span>${flake.area.toFixed(1)} µm<sup>2</sup></span></div>
                <div class="flake-meta-item">θ: <span>${flake.orientation}°</span></div>
            </div>
            <textarea class="flake-notes" placeholder="Add notes… (e.g. good crystal, no cracks)" data-flake-id="${flake.id}">${flake.notes || ''}</textarea>
            <div class="card-actions" style="gap:0.4rem; margin-top:0.1rem;">
                <button class="danger" onclick="deleteFlake('${flake.id}', event)" style="padding:0.2rem 0.5rem; font-size:0.68rem;">🗑 Delete</button>
            </div>
        `;
        
        card.addEventListener('mouseenter', () => {
            state.hoveredFlakeId = flake.id;
            redraw();
            highlightTableRow(flake.id);
        });

        card.addEventListener('mouseleave', () => {
            state.hoveredFlakeId = null;
            redraw();
            highlightTableRow(null);
        });

        card.addEventListener('click', (e) => {
            // Don't select when clicking the textarea, button, input, select, or colour swatch
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            if (e.target.classList.contains('flake-color-swatch')) return;
            selectFlake(flake.id);
        });

        // Colour swatch — open palette popup
        const swatchEl = card.querySelector('.flake-color-swatch');
        if (swatchEl) {
            swatchEl.addEventListener('click', (e) => {
                e.stopPropagation();
                showColorPalette(flake.id, swatchEl);
            });
        }

        // Notes persistence
        const notesEl = card.querySelector('.flake-notes');
        if (notesEl) {
            notesEl.addEventListener('input', (e) => {
                e.stopPropagation();
                updateFlakeNote(flake.id, e.target.value);
            });
            notesEl.addEventListener('click', (e) => e.stopPropagation());
        }

        listContainer.appendChild(card);

        // Populate the legacy data-table row only if the element is still in the DOM
        if (tableBody) {
            const row = document.createElement('tr');
            row.id = `row-${flake.id}`;
            row.className = isSelected ? 'selected-flake' : '';
            row.innerHTML = `
                <td><input type="text" value="${flake.name}" style="padding:0.2rem;font-size:0.7rem;width:90px;background:transparent;border:none;border-bottom:1px dashed var(--border-color);color:var(--text-primary);" onchange="updateFlakeName('${flake.id}',this.value)" onclick="event.stopPropagation()"></td>
                <td>${flake.x_um.toFixed(3)}</td><td>${flake.y_um.toFixed(3)}</td>
                <td>${flake.length.toFixed(2)}</td><td>${flake.width.toFixed(2)}</td>
                <td>${(flake.length/flake.width).toFixed(2)}</td>
                <td>${flake.area.toFixed(1)}</td><td>${flake.orientation}°</td>
                <td><span style="font-size:0.7rem;padding:0.15rem 0.4rem;border-radius:4px;background:${flake.color||'#6b7280'}22;color:${flake.color||'#6b7280'};border:1px solid ${flake.color||'#6b7280'}44;">${flake.customTag}</span></td>
            `;
            row.addEventListener('mouseenter', () => { state.hoveredFlakeId = flake.id; redraw(); card.classList.add('hover'); });
            row.addEventListener('mouseleave', () => { state.hoveredFlakeId = null; redraw(); card.classList.remove('hover'); });
            row.addEventListener('click', e => { if (e.target.tagName==='INPUT'||e.target.tagName==='SELECT') return; selectFlake(flake.id); });
            tableBody.appendChild(row);
        }
    });
    updateLiveStats();
}

function selectFlake(flakeId) {
    if (state.selectedFlakeId === flakeId) {
        state.selectedFlakeId = null;
    } else {
        state.selectedFlakeId = flakeId;
        
        // Zoom and center on selected flake
        const imgObj = state.images.find(img => img.id === state.activeImageId);
        const flake = imgObj.flakes.find(f => f.id === flakeId);
        if (flake) {
            state.zoom = 2.0; // zoom level
            state.pan.x = canvas.width / 2 - flake.centroid.x * state.zoom;
            state.pan.y = canvas.height / 2 - flake.centroid.y * state.zoom;
            updateZoomDisplay();
        }
    }
    
    renderFlakes();
    redraw();
}

function deleteFlake(flakeId, event) {
    if (event) event.stopPropagation();
    
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj) return;
    
    const idx = imgObj.flakes.findIndex(f => f.id === flakeId);
    if (idx !== -1) {
        pushToUndoStack();
        imgObj.flakes.splice(idx, 1);
        if (state.selectedFlakeId === flakeId) state.selectedFlakeId = null;
        if (state.hoveredFlakeId === flakeId) state.hoveredFlakeId = null;
        
        showToast("Flake annotation deleted", "warning");
        renderFlakes();
        redraw();
    }
}

function updateFlakeTag(flakeId, val) {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj) return;
    const flake = imgObj.flakes.find(f => f.id === flakeId);
    if (flake) {
        flake.customTag = val;
        showToast(`Tag updated to: ${val}`, 'info');
        renderFlakes();
        redraw();
    }
}

function updateFlakeName(flakeId, val) {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj) return;
    const flake = imgObj.flakes.find(f => f.id === flakeId);
    if (flake) {
        flake.name = val;
        showToast(`Flake name updated to: ${val}`, 'info');
        renderFlakes();
        redraw();
    }
}

// ── Colour Palette Popup ─────────────────────────────────────────────────────
const COLOR_PALETTE = [
    '#06b6d4','#22d3ee','#38bdf8','#3b82f6','#6366f1',
    '#10b981','#34d399','#4ade80','#84cc16','#a3e635',
    '#f59e0b','#fb923c','#ef4444','#f43f5e','#e879f9',
    '#a855f7','#c084fc','#f472b6','#fb7185','#fda4af',
    '#94a3b8','#64748b','#e2e8f0','#ffffff','#1e293b',
];

let _colorPaletteTarget = null;
let _cpOutsideHandler   = null;

function _getOrBuildPopup() {
    let popup = document.getElementById('color-palette-popup');
    if (popup) return popup;

    popup = document.createElement('div');
    popup.id = 'color-palette-popup';
    popup.innerHTML = `
        <div class="cp-swatches"></div>
        <div class="cp-hex-row">
            <span class="cp-hex-hash">#</span>
            <input class="cp-hex-input" type="text" maxlength="6" placeholder="hex" spellcheck="false">
            <button class="cp-hex-apply" title="Apply hex colour">✓</button>
        </div>`;
    document.body.appendChild(popup);

    const grid = popup.querySelector('.cp-swatches');
    COLOR_PALETTE.forEach(hex => {
        const sw = document.createElement('button');
        sw.className = 'cp-swatch';
        sw.style.background = hex;
        sw.title = hex;
        sw.addEventListener('mousedown', e => e.preventDefault()); // prevent focus loss
        sw.addEventListener('click', e => { e.stopPropagation(); _applyColor(hex); });
        grid.appendChild(sw);
    });

    const applyBtn = popup.querySelector('.cp-hex-apply');
    const hexInput = popup.querySelector('.cp-hex-input');

    applyBtn.addEventListener('click', e => {
        e.stopPropagation();
        const val = hexInput.value.trim().replace(/^#/, '');
        if (/^[0-9a-fA-F]{6}$/.test(val)) _applyColor('#' + val);
    });
    hexInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.stopPropagation(); applyBtn.click(); }
        e.stopPropagation();
    });

    // Prevent clicks inside popup from reaching the outside-click handler
    popup.addEventListener('click', e => e.stopPropagation());

    return popup;
}

function showColorPalette(flakeId, swatchEl) {
    const popup = _getOrBuildPopup();

    // Toggle closed if already open for the same flake
    if (_colorPaletteTarget && _colorPaletteTarget.flakeId === flakeId && popup.classList.contains('cp-visible')) {
        _hideColorPalette();
        return;
    }

    _colorPaletteTarget = { flakeId, swatchEl };

    // Position
    const rect = swatchEl.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - 195);
    const top  = rect.bottom + 6;
    popup.style.left = left + 'px';
    popup.style.top  = top  + 'px';

    // Pre-fill current colour
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    const flake  = imgObj && imgObj.flakes.find(f => f.id === flakeId);
    const cur    = (flake && flake.color) || '#f59e0b';
    popup.querySelector('.cp-hex-input').value = cur.replace('#', '');
    popup.querySelectorAll('.cp-swatch').forEach(sw =>
        sw.classList.toggle('cp-swatch-active', sw.title.toLowerCase() === cur.toLowerCase())
    );

    popup.classList.add('cp-visible');

    // Attach outside-click handler after this event finishes (setTimeout avoids
    // the current click itself triggering the handler immediately)
    if (_cpOutsideHandler) document.removeEventListener('click', _cpOutsideHandler);
    _cpOutsideHandler = function(e) {
        if (!popup.contains(e.target)) _hideColorPalette();
    };
    setTimeout(() => document.addEventListener('click', _cpOutsideHandler), 0);
}

function _hideColorPalette() {
    const popup = document.getElementById('color-palette-popup');
    if (popup) popup.classList.remove('cp-visible');
    if (_cpOutsideHandler) {
        document.removeEventListener('click', _cpOutsideHandler);
        _cpOutsideHandler = null;
    }
}

function _applyColor(hex) {
    if (!_colorPaletteTarget) return;
    updateFlakeColor(_colorPaletteTarget.flakeId, hex);
    const popup = document.getElementById('color-palette-popup');
    if (popup) {
        popup.querySelector('.cp-hex-input').value = hex.replace('#', '');
        popup.querySelectorAll('.cp-swatch').forEach(sw =>
            sw.classList.toggle('cp-swatch-active', sw.title.toLowerCase() === hex.toLowerCase())
        );
    }
}

// ── COLORMAPS ─────────────────────────────────────────────────────────────────
// [r,g,b] stops (0–255) at equal spacing; linearly interpolated.
const COLORMAPS = {
    'Magma':      [[0,0,4],[28,16,68],[79,18,123],[129,37,129],[181,54,122],[229,80,100],[251,135,97],[254,194,135],[252,253,191]],
    'Inferno':    [[0,0,4],[31,12,72],[85,15,109],[139,34,82],[185,57,52],[220,93,30],[246,135,24],[248,190,82],[252,255,164]],
    'Plasma':     [[13,8,135],[84,2,163],[139,10,165],[185,50,137],[219,92,104],[244,136,73],[254,188,43],[240,249,33]],
    'Viridis':    [[68,1,84],[72,40,120],[62,83,160],[49,120,173],[35,152,176],[30,184,162],[81,208,121],[163,220,73],[253,231,37]],
    'Turbo':      [[48,18,59],[86,74,172],[50,168,235],[22,219,162],[57,251,80],[173,247,49],[250,200,51],[244,121,19],[195,47,6],[122,4,3]],
    'Jet':        [[0,0,127],[0,0,255],[0,127,255],[0,255,255],[127,255,127],[255,255,0],[255,127,0],[255,0,0],[127,0,0]],
    'HSV':        [[255,0,0],[255,255,0],[0,255,0],[0,255,255],[0,0,255],[255,0,255],[255,0,0]],
    'Rainbow':    [[127,0,255],[0,0,255],[0,127,255],[0,255,0],[255,255,0],[255,127,0],[255,0,0]],
    'Hot':        [[10,0,0],[85,0,0],[170,0,0],[255,0,0],[255,85,0],[255,170,0],[255,255,0],[255,255,255]],
    'Cool':       [[0,255,255],[32,222,255],[64,190,255],[128,128,255],[190,64,255],[222,32,255],[255,0,255]],
    'Cool-Warm':  [[59,76,192],[98,130,234],[184,208,249],[220,227,233],[242,218,201],[248,178,145],[231,126,88],[180,4,38]],
    'Blue-White-Red': [[0,0,255],[128,128,255],[255,255,255],[255,128,128],[255,0,0]],
    'Red-White-Blue': [[255,0,0],[255,128,128],[255,255,255],[128,128,255],[0,0,255]],
    'Grayscale':  [[0,0,0],[64,64,64],[128,128,128],[192,192,192],[255,255,255]],
    'Spectrum':   [[255,0,255],[0,0,255],[0,255,255],[0,255,0],[255,255,0],[255,128,0],[255,0,0]],
    'Terrain':    [[51,102,153],[80,160,200],[130,200,130],[80,150,60],[160,130,80],[210,190,140],[255,255,255]],
    'Copper':     [[0,0,0],[80,50,30],[160,100,60],[220,138,84],[255,161,96]],
    'Bone':       [[0,0,0],[60,60,80],[120,120,140],[180,185,185],[255,255,255]],
    'Autumn':     [[255,0,0],[255,64,0],[255,128,0],[255,192,0],[255,255,0]],
    'Winter':     [[0,0,255],[0,64,223],[0,128,191],[0,192,159],[0,255,128]],
    'Spring':     [[255,0,255],[255,64,191],[255,128,128],[255,192,64],[255,255,0]],
    'Summer':     [[0,128,102],[64,153,102],[128,179,102],[192,204,102],[255,230,102]],
    'Ocean':      [[0,0,128],[0,50,180],[0,130,160],[0,180,80],[0,210,0],[100,230,0],[255,255,255]],
    'Gist Earth': [[0,0,0],[40,30,80],[60,110,140],[100,150,100],[160,130,80],[210,190,140],[255,255,255]],
    'Gnuplot':    [[0,0,0],[64,0,128],[128,0,255],[200,32,192],[255,64,0],[255,200,0],[255,255,255]],
    'Gnuplot2':   [[0,0,0],[0,0,255],[0,200,255],[0,255,128],[255,255,0],[255,128,0],[255,255,255]],
    'Cividis':    [[0,32,77],[0,62,103],[58,94,111],[112,126,122],[168,160,135],[228,197,149],[255,216,157]],
    'Twilight':   [[226,217,226],[172,147,196],[114,87,158],[72,55,115],[59,53,89],[78,77,110],[162,155,178],[226,217,226]],
    'Twilight Shifted': [[59,53,89],[114,87,158],[226,217,226],[162,155,178],[78,77,110],[59,53,89]],
    'Black-Body Radiation': [[0,0,0],[80,0,0],[180,50,0],[240,170,40],[255,240,170],[255,255,255]],
    'Seismic':    [[0,0,180],[0,0,255],[128,128,255],[255,255,255],[255,128,128],[255,0,0],[180,0,0]],
    'RdBu':       [[103,0,31],[214,96,77],[253,219,199],[247,247,247],[209,229,240],[67,147,195],[5,48,97]],
    'RdYlBu':     [[165,0,38],[244,109,67],[254,224,144],[255,255,191],[171,217,233],[69,117,180],[49,54,149]],
    'RdYlGn':     [[165,0,38],[244,109,67],[254,224,139],[255,255,191],[166,217,106],[26,152,80],[0,104,55]],
    'Spectral':   [[158,1,66],[244,109,67],[254,224,139],[255,255,191],[171,221,164],[50,136,189],[94,79,162]],
    'PiYG':       [[142,1,82],[222,119,174],[253,224,239],[247,247,247],[184,225,134],[77,146,33],[39,100,25]],
    'PRGn':       [[64,0,75],[153,112,171],[231,212,232],[247,247,247],[166,219,160],[27,120,55],[0,68,27]],
    'BrBG':       [[84,48,5],[191,129,45],[246,232,195],[245,245,245],[199,234,229],[1,102,94],[0,60,48]],
    'PuOr':       [[127,59,8],[224,130,20],[254,224,182],[247,247,247],[178,171,210],[84,39,136],[45,0,75]]
};

function _sampleColormap(name, t) {
    const stops = COLORMAPS[name];
    if (!stops || !stops.length) return '#ffffff';
    t = Math.max(0, Math.min(1, t));
    const n  = stops.length - 1;
    const fi = t * n;
    const lo = Math.floor(fi), hi = Math.min(lo + 1, n);
    const f  = fi - lo;
    const [r0,g0,b0] = stops[lo], [r1,g1,b1] = stops[hi];
    const r = Math.round(r0 + f*(r1-r0));
    const g = Math.round(g0 + f*(g1-g0));
    const b = Math.round(b0 + f*(b1-b0));
    return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
}

function applyColormap(name) {
    if (!name) return;
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj || !imgObj.flakes.length) { showToast('No flakes to colorize', 'warning'); return; }
    const n = imgObj.flakes.length;
    imgObj.flakes.forEach((flake, i) => {
        const t = n > 1 ? i / (n - 1) : 0.5;
        flake.color    = _sampleColormap(name, t);               // outline, centroid, flake number
        flake.dimColor = _sampleColormap(name, (t + 0.33) % 1); // L×W dim string
        flake.armColor = _sampleColormap(name, (t + 0.67) % 1); // length & width arm labels + lines
    });
    renderFlakes();
    redraw();
    showToast(`"${name}" applied to ${n} flakes`, 'info');
}

function updateFlakeColor(flakeId, hexColor) {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj) return;
    const flake = imgObj.flakes.find(f => f.id === flakeId);
    if (!flake) return;
    flake.color = hexColor;
    // Update dot + accent bar without full re-render
    const swatch = document.querySelector(`.flake-color-swatch[onclick*="${flakeId}"]`);
    if (swatch) swatch.style.backgroundColor = hexColor;
    const card = document.querySelector(`.flake-card[data-id="${flakeId}"]`);
    if (card) card.style.setProperty('--flake-accent', hexColor);
    redraw();
}

// ── Rotation Modal ────────────────────────────────────────────────────────────
let _rotateState = { angle: 0, flipH: false, flipV: false, dragging: false, lastMouseAngle: 0 };

function openRotateModal() {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj || !imgObj.imageEl) { showToast('Load an image first', 'warning'); return; }

    _rotateState = { angle: 0, flipH: false, flipV: false, dragging: false, lastMouseAngle: 0 };
    document.getElementById('rotate-slider').value    = 0;
    document.getElementById('rotate-fine-input').value = '0';
    document.getElementById('rotate-angle-badge').textContent = '0.0°';

    document.getElementById('rotate-modal').classList.add('active');
    _drawRotatePreview();
    _setupRotateDrag();
}

function closeRotateModal() {
    document.getElementById('rotate-modal').classList.remove('active');
}

function _drawRotatePreview() {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj || !imgObj.imageEl) return;

    const cvs  = document.getElementById('rotate-preview-canvas');
    const wrap = document.getElementById('rotate-preview-wrap');
    const maxW = wrap.clientWidth  - 2;
    const maxH = 260;

    const rad  = _rotateState.angle * Math.PI / 180;
    const sinA = Math.abs(Math.sin(rad)), cosA = Math.abs(Math.cos(rad));
    const iw   = imgObj.imageEl.naturalWidth, ih = imgObj.imageEl.naturalHeight;
    const rw   = iw * cosA + ih * sinA, rh = iw * sinA + ih * cosA;

    const scale = Math.min(maxW / rw, maxH / rh, 1);
    cvs.width   = Math.round(rw * scale);
    cvs.height  = Math.round(rh * scale);

    const ctx2 = cvs.getContext('2d');
    ctx2.clearRect(0, 0, cvs.width, cvs.height);

    // Checkerboard background (shows canvas area)
    for (let y = 0; y < cvs.height; y += 12) {
        for (let x = 0; x < cvs.width; x += 12) {
            ctx2.fillStyle = ((x + y) / 12 % 2 < 1) ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)';
            ctx2.fillRect(x, y, 12, 12);
        }
    }

    ctx2.save();
    ctx2.translate(cvs.width / 2, cvs.height / 2);
    ctx2.rotate(rad);
    if (_rotateState.flipH) ctx2.scale(-1,  1);
    if (_rotateState.flipV) ctx2.scale( 1, -1);
    ctx2.scale(scale, scale);
    ctx2.drawImage(imgObj.imageEl, -iw / 2, -ih / 2);
    ctx2.restore();

    // Angle badge
    const badge = document.getElementById('rotate-angle-badge');
    const display = _rotateState.angle.toFixed(1) +
        (_rotateState.flipH ? ' ⇔H' : '') + (_rotateState.flipV ? ' ⇕V' : '');
    badge.textContent = display;
}

function _setupRotateDrag() {
    const cvs = document.getElementById('rotate-preview-canvas');
    // Remove old listeners by cloning
    const fresh = cvs.cloneNode(false);
    cvs.parentNode.replaceChild(fresh, cvs);
    fresh.id = 'rotate-preview-canvas';
    fresh.style.cssText = 'max-width:100%; max-height:260px; display:block; cursor:grab;';
    _drawRotatePreview();

    let startAngle = 0;
    let startRotate = 0;

    const getAngle = (e) => {
        const r   = fresh.getBoundingClientRect();
        const cx  = r.left + r.width  / 2;
        const cy  = r.top  + r.height / 2;
        const ex  = (e.touches ? e.touches[0].clientX : e.clientX);
        const ey  = (e.touches ? e.touches[0].clientY : e.clientY);
        return Math.atan2(ey - cy, ex - cx) * 180 / Math.PI;
    };

    const onDown = (e) => {
        e.preventDefault();
        _rotateState.dragging = true;
        startAngle  = getAngle(e);
        startRotate = _rotateState.angle;
        fresh.style.cursor = 'grabbing';
    };
    const onMove = (e) => {
        if (!_rotateState.dragging) return;
        e.preventDefault();
        const delta = getAngle(e) - startAngle;
        _rotateState.angle = startRotate + delta;
        _syncRotateUI(_rotateState.angle);
        _drawRotatePreview();
    };
    const onUp = () => {
        _rotateState.dragging = false;
        fresh.style.cursor = 'grab';
    };

    fresh.addEventListener('mousedown',  onDown);
    fresh.addEventListener('touchstart', onDown, { passive: false });
    document.addEventListener('mousemove',  onMove);
    document.addEventListener('touchmove',  onMove, { passive: false });
    document.addEventListener('mouseup',    onUp);
    document.addEventListener('touchend',   onUp);
}

function _syncRotateUI(angle) {
    const clamped = Math.max(-180, Math.min(180, angle));
    document.getElementById('rotate-slider').value     = clamped;
    document.getElementById('rotate-fine-input').value = angle.toFixed(1);
}

function syncRotateFromSlider(val) {
    _rotateState.angle = parseFloat(val);
    document.getElementById('rotate-fine-input').value = parseFloat(val).toFixed(1);
    _drawRotatePreview();
}

function syncRotateFromInput(val) {
    _rotateState.angle = parseFloat(val) || 0;
    const clamped = Math.max(-180, Math.min(180, _rotateState.angle));
    document.getElementById('rotate-slider').value = clamped;
    _drawRotatePreview();
}

function setRotateAngle(deg) {
    _rotateState.angle += deg;
    _syncRotateUI(_rotateState.angle);
    _drawRotatePreview();
}

function resetRotateAngle() {
    _rotateState.angle = 0;
    _rotateState.flipH = false;
    _rotateState.flipV = false;
    _syncRotateUI(0);
    _drawRotatePreview();
}

function flipRotateImage(axis) {
    if (axis === 'h') _rotateState.flipH = !_rotateState.flipH;
    if (axis === 'v') _rotateState.flipV = !_rotateState.flipV;
    _drawRotatePreview();
}

function applyRotateModal() {
    const { angle, flipH, flipV } = _rotateState;
    closeRotateModal();
    if (flipH || flipV) _applyFlip(flipH, flipV);
    if (Math.abs(angle) > 0.01) rotateActiveImage(angle);
    else if (!flipH && !flipV) showToast('No rotation applied', 'info');
    setTool('pan');
}

function _applyFlip(flipH, flipV) {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj || !imgObj.imageEl) return;
    const iw = imgObj.imageEl.naturalWidth, ih = imgObj.imageEl.naturalHeight;
    const cvt = document.createElement('canvas');
    cvt.width = iw; cvt.height = ih;
    const fc = cvt.getContext('2d');
    fc.translate(flipH ? iw : 0, flipV ? ih : 0);
    fc.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    fc.drawImage(imgObj.imageEl, 0, 0);
    let dataUrl;
    try   { dataUrl = cvt.toDataURL('image/jpeg', 0.95); }
    catch (e) { showToast('Flip blocked — use local server', 'error'); return; }

    // Mirror flake coordinates
    imgObj.flakes.forEach(flake => {
        const mirrorPt = p => ({
            x: flipH ? iw - p.x : p.x,
            y: flipV ? ih - p.y : p.y
        });
        flake.centroid = mirrorPt(flake.centroid);
        if (flake.points)      flake.points      = flake.points.map(mirrorPt);
        if (flake.orientedBox) flake.orientedBox  = flake.orientedBox.map(mirrorPt);
    });
    if (imgObj.origin) imgObj.origin = {
        x: flipH ? iw - imgObj.origin.x : imgObj.origin.x,
        y: flipV ? ih - imgObj.origin.y : imgObj.origin.y
    };

    const newImg = new Image();
    newImg.onload = () => {
        imgObj.imageEl = newImg;
        imgObj.dataUrl = dataUrl;
        loadImage(imgObj.id);
        showToast(`Flip applied${flipH ? ' H' : ''}${flipV ? ' V' : ''}`, 'info');
    };
    newImg.src = dataUrl;
}

// ── Image Rotation ────────────────────────────────────────────────────────────
function _rotatePoint(p, sinA, cosA, ocx, ocy, ncx, ncy) {
    const dx = p.x - ocx, dy = p.y - ocy;
    return {
        x: ncx + dx * cosA - dy * sinA,
        y: ncy + dx * sinA + dy * cosA
    };
}

function rotateActiveImage(angleDeg) {
    if (!angleDeg || isNaN(angleDeg)) { showToast('Enter a valid angle', 'warning'); return; }
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj || !imgObj.imageEl) { showToast('No active image to rotate', 'warning'); return; }

    pushToUndoStack();

    const rad  = angleDeg * Math.PI / 180;
    const sinA = Math.sin(rad), cosA = Math.cos(rad);
    const ow = imgObj.imageEl.naturalWidth, oh = imgObj.imageEl.naturalHeight;

    // New canvas size that fits the rotated image exactly
    const nw = Math.round(Math.abs(ow * cosA) + Math.abs(oh * sinA));
    const nh = Math.round(Math.abs(ow * sinA) + Math.abs(oh * cosA));

    const cvt  = document.createElement('canvas');
    cvt.width  = nw;
    cvt.height = nh;
    const rctx = cvt.getContext('2d');
    rctx.translate(nw / 2, nh / 2);
    rctx.rotate(rad);
    rctx.drawImage(imgObj.imageEl, -ow / 2, -oh / 2);

    let dataUrl;
    try   { dataUrl = cvt.toDataURL('image/jpeg', 0.95); }
    catch (e) { showToast('Rotation blocked — run via local server', 'error'); return; }

    const ocx = ow / 2, ocy = oh / 2;
    const ncx = nw / 2, ncy = nh / 2;

    // ── Rotate all flake geometry ──────────────────────────────────────────
    imgObj.flakes.forEach(flake => {
        const rp = p => _rotatePoint(p, sinA, cosA, ocx, ocy, ncx, ncy);

        flake.centroid = rp(flake.centroid);

        if (flake.points && flake.points.length)
            flake.points = flake.points.map(rp);

        if (flake.orientedBox && flake.orientedBox.length)
            flake.orientedBox = flake.orientedBox.map(rp);

        // Bounding box — recompute from rotated points/OBB
        const pts = flake.orientedBox || flake.points || [];
        if (pts.length) {
            flake.boundingBox = {
                minX: Math.min(...pts.map(p => p.x)),
                maxX: Math.max(...pts.map(p => p.x)),
                minY: Math.min(...pts.map(p => p.y)),
                maxY: Math.max(...pts.map(p => p.y))
            };
        }

        // Orientation angle
        flake.orientation = Math.round(((flake.orientation || 0) + angleDeg + 360) % 360);

        // Physical coordinates will be recalculated after loadImage updates origin/scale
    });

    // ── Rotate origin ──────────────────────────────────────────────────────
    if (imgObj.origin) {
        imgObj.origin = _rotatePoint(imgObj.origin, sinA, cosA, ocx, ocy, ncx, ncy);
    }

    // ── Swap in the new image ──────────────────────────────────────────────
    const newImg   = new Image();
    newImg.onload  = () => {
        imgObj.imageEl = newImg;
        imgObj.dataUrl = dataUrl;
        imgObj.width   = nw;
        imgObj.height  = nh;

        // Recompute physical µm coordinates for every flake
        const sr = imgObj.scaleRatio || state.scaleRatio || 1;
        const ori = imgObj.origin || { x: 0, y: 0 };
        const yInv = imgObj.yAxisInverted !== false;
        imgObj.flakes.forEach(flake => {
            const dx = (flake.centroid.x - ori.x) / sr;
            const dy = (flake.centroid.y - ori.y) / sr;
            flake.x_um = dx;
            flake.y_um = yInv ? -dy : dy;
        });

        loadImage(imgObj.id);
        showToast(`Image rotated ${angleDeg > 0 ? '+' : ''}${angleDeg}°`, 'info');
    };
    newImg.onerror = () => showToast('Failed to apply rotation', 'error');
    newImg.src = dataUrl;
}

function handleTagSelectChange(flakeId, selectEl) {
    const val = selectEl.value;
    const inputEl = selectEl.parentElement.querySelector('.custom-tag-input');
    if (val === 'custom') {
        if (inputEl) {
            inputEl.style.display = 'inline-block';
            inputEl.value = '';
            inputEl.focus();
        }
    } else {
        if (inputEl) inputEl.style.display = 'none';
        updateFlakeTag(flakeId, val);
    }
}

function updateFlakeNote(flakeId, text) {
    // Find the flake across all images (may be any loaded image)
    for (const imgObj of state.images) {
        const flake = imgObj.flakes.find(f => f.id === flakeId);
        if (flake) {
            flake.notes = text;
            return; // no re-render needed — textarea is already updated live
        }
    }
}

function highlightTableRow(flakeId) {
    document.querySelectorAll('#data-table tbody tr').forEach(row => {
        row.classList.remove('selected-flake');
    });
    if (flakeId) {
        const row = document.getElementById(`row-${flakeId}`);
        if (row) row.classList.add('selected-flake');
    }
}

function renderSubstrateList() {
    const selector = document.getElementById('substrate-list');
    selector.innerHTML = '';
    
    state.images.forEach(img => {
        const activeClass = (img.id === state.activeImageId) ? 'active' : '';

        // Annotate with grid position if assigned
        let gridTag = '';
        if (state.gridLayout.enabled) {
            for (const key in state.gridLayout.cells) {
                if (state.gridLayout.cells[key] === img.id) {
                    const [r, c] = key.split(',').map(Number);
                    gridTag = ` · <span style="color:var(--secondary);font-weight:600;">R${r+1}C${c+1}</span>`;
                    break;
                }
            }
        }

        const item = document.createElement('div');
        item.className = `substrate-item ${activeClass}`;
        item.innerHTML = `
            <div class="substrate-item-info">
                <div class="substrate-item-title" title="${img.name}">${img.name}</div>
                <div class="substrate-item-meta">${img.flakes.length} flakes${gridTag}</div>
            </div>
            <button class="delete-substrate-btn" title="Remove Substrate">&times;</button>
        `;
        
        item.addEventListener('click', () => {
            loadImage(img.id);
        });
        
        const deleteBtn = item.querySelector('.delete-substrate-btn');
        deleteBtn.addEventListener('click', (e) => {
            deleteSubstrate(img.id, e);
        });
        
        selector.appendChild(item);
    });
    
    // Add "➕ Load Substrate Image" button at the bottom of the substrate list
    const loadMoreItem = document.createElement('div');
    loadMoreItem.className = 'substrate-item load-more-item';
    loadMoreItem.innerHTML = '➕ Load Substrate Image';
    loadMoreItem.addEventListener('click', () => {
        document.getElementById('image-upload').click();
    });
    selector.appendChild(loadMoreItem);
}

function deleteSubstrate(imageId, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    
    const index = state.images.findIndex(img => img.id === imageId);
    if (index === -1) return;
    
    pushToUndoStack();
    state.images.splice(index, 1);
    
    if (state.activeImageId === imageId) {
        if (state.images.length > 0) {
            loadImage(state.images[0].id);
        } else {
            state.activeImageId = null;
            loadedImageEl = null;
            
            // Clear canvases
            if (canvas && ctx) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
            if (offscreenCanvas) {
                offscreenCanvas.width = 0;
                offscreenCanvas.height = 0;
            }
            if (filteredCanvas) {
                filteredCanvas.width = 0;
                filteredCanvas.height = 0;
            }
            
            // Reset input values
            document.getElementById('input-scale').value = '1.000';
            document.getElementById('input-origin-x').value = '0';
            document.getElementById('input-origin-y').value = '0';
            
            renderSubstrateList();
            renderFlakes();
            redraw();
        }
    } else {
        renderSubstrateList();
        renderFlakes();
        redraw();
    }
    
    showToast("Substrate removed", "info");
}

// ----------------------------------------------------
// Matrix Grid Layout
// ----------------------------------------------------

/** Returns the representative cell dimensions (width, height) from the first assigned image. */
function getGridCellDimensions() {
    const { cells } = state.gridLayout;
    for (const key in cells) {
        const img = state.images.find(i => i.id === cells[key]);
        if (img) return { cellW: img.width, cellH: img.height };
    }
    // Fallback to active image or a safe default
    const active = state.images.find(i => i.id === state.activeImageId);
    if (active) return { cellW: active.width, cellH: active.height };
    return { cellW: 1000, cellH: 800 };
}

/** Recompute every image's offset from its grid cell assignment. */
function recalcGridOffsets() {
    const { rows, cols, gapX, gapY, cells } = state.gridLayout;
    const { cellW, cellH } = getGridCellDimensions();
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const key = `${r},${c}`;
            const imageId = cells[key];
            if (!imageId) continue;
            const img = state.images.find(i => i.id === imageId);
            if (!img) continue;
            img.offset = { x: c * (cellW + gapX), y: r * (cellH + gapY) };
        }
    }
}

/** Draw faint dashed cell borders and empty-cell labels on the canvas. */
function drawGridOverlay() {
    const { rows, cols, gapX, gapY, cells } = state.gridLayout;
    const { cellW, cellH } = getGridCellDimensions();
    const zoom = state.zoom;

    ctx.save();
    ctx.setTransform(zoom, 0, 0, zoom, state.pan.x, state.pan.y);

    // Cell border style
    ctx.strokeStyle = 'rgba(6,182,212,0.35)';
    ctx.lineWidth = 2 / zoom;
    ctx.setLineDash([10 / zoom, 5 / zoom]);

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const x = c * (cellW + gapX);
            const y = r * (cellH + gapY);
            ctx.strokeRect(x, y, cellW, cellH);
        }
    }
    ctx.setLineDash([]);

    // Labels for empty cells
    const fontSize = Math.max(14, Math.round(28 / zoom));
    ctx.font = `600 ${fontSize}px Inter, sans-serif`;
    ctx.fillStyle = 'rgba(6,182,212,0.5)';
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const key = `${r},${c}`;
            const x = c * (cellW + gapX) + 12 / zoom;
            const y = r * (cellH + gapY) + fontSize + 8 / zoom;
            if (!cells[key]) {
                ctx.fillText(`R${r + 1}C${c + 1}  (empty)`, x, y);
            } else {
                // Light position tag on occupied cells
                ctx.fillStyle = 'rgba(6,182,212,0.3)';
                ctx.fillText(`R${r + 1}C${c + 1}`, x, y);
                ctx.fillStyle = 'rgba(6,182,212,0.5)';
            }
        }
    }

    // Overall bounding rect
    ctx.strokeStyle = 'rgba(6,182,212,0.6)';
    ctx.lineWidth = 3 / zoom;
    ctx.setLineDash([]);
    const totalW = cols * (cellW + gapX) - gapX;
    const totalH = rows * (cellH + gapY) - gapY;
    ctx.strokeRect(0, 0, totalW, totalH);

    ctx.restore();
}

/** Open (or re-open) the grid setup modal. */
function openGridModal() {
    let modal = document.getElementById('grid-modal');
    if (!modal) {
        modal = buildGridModal();
        document.body.appendChild(modal);
    }
    // Sync inputs with current state
    modal.querySelector('#grid-rows').value = state.gridLayout.rows;
    modal.querySelector('#grid-cols').value = state.gridLayout.cols;
    modal.querySelector('#grid-gap-x').value = state.gridLayout.gapX;
    modal.querySelector('#grid-gap-y').value = state.gridLayout.gapY;
    renderGridModalCells();
    modal.style.display = 'flex';
}

function closeGridModal() {
    const modal = document.getElementById('grid-modal');
    if (modal) modal.style.display = 'none';
    const menu = document.getElementById('cell-assign-menu');
    if (menu) menu.remove();
}

/** Build the modal DOM (only once). */
function buildGridModal() {
    const modal = document.createElement('div');
    modal.id = 'grid-modal';
    modal.style.cssText = `
        display:none; position:fixed; inset:0; background:rgba(0,0,0,0.72);
        z-index:2000; align-items:center; justify-content:center; padding:1rem;
    `;
    modal.innerHTML = `
      <div style="background:var(--bg-panel-solid); border-radius:14px; padding:1.5rem;
                  width:min(96vw,740px); max-height:92vh; overflow-y:auto;
                  box-shadow:0 24px 64px rgba(0,0,0,0.6); border:1px solid var(--border-color);">

        <!-- Header -->
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.1rem;">
          <div>
            <div style="color:var(--text-primary); font-size:0.95rem; font-weight:700;">🔲 Matrix Grid Upload</div>
            <div style="color:var(--text-muted); font-size:0.7rem; margin-top:0.2rem;">
              Define a rows × columns grid and assign one substrate image per cell.
              Images are auto-positioned on the canvas to form a seamless mosaic.
            </div>
          </div>
          <button id="grid-modal-close" style="background:none; border:none; color:var(--text-muted);
              font-size:1.6rem; cursor:pointer; line-height:1; padding:0 0.25rem;">&times;</button>
        </div>

        <!-- Grid dimension controls -->
        <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:0.6rem; margin-bottom:1rem;">
          <div>
            <label style="font-size:0.68rem; color:var(--text-muted); display:block; margin-bottom:0.2rem;">Rows</label>
            <input type="number" id="grid-rows" min="1" max="10" value="3"
              style="width:100%; padding:0.35rem; border-radius:6px; border:1px solid var(--border-color);
                     background:var(--bg-panel-solid); color:var(--text-primary); font-size:0.8rem;">
          </div>
          <div>
            <label style="font-size:0.68rem; color:var(--text-muted); display:block; margin-bottom:0.2rem;">Columns</label>
            <input type="number" id="grid-cols" min="1" max="10" value="3"
              style="width:100%; padding:0.35rem; border-radius:6px; border:1px solid var(--border-color);
                     background:var(--bg-panel-solid); color:var(--text-primary); font-size:0.8rem;">
          </div>
          <div>
            <label style="font-size:0.68rem; color:var(--text-muted); display:block; margin-bottom:0.2rem;">H-Gap (px)</label>
            <input type="number" id="grid-gap-x" min="0" max="1000" value="10"
              style="width:100%; padding:0.35rem; border-radius:6px; border:1px solid var(--border-color);
                     background:var(--bg-panel-solid); color:var(--text-primary); font-size:0.8rem;">
          </div>
          <div>
            <label style="font-size:0.68rem; color:var(--text-muted); display:block; margin-bottom:0.2rem;">V-Gap (px)</label>
            <input type="number" id="grid-gap-y" min="0" max="1000" value="10"
              style="width:100%; padding:0.35rem; border-radius:6px; border:1px solid var(--border-color);
                     background:var(--bg-panel-solid); color:var(--text-primary); font-size:0.8rem;">
          </div>
        </div>

        <!-- Grid cell preview -->
        <div style="font-size:0.68rem; color:var(--text-muted); margin-bottom:0.4rem;">
          Click any cell to upload a new image or assign an existing one:
        </div>
        <div id="grid-cell-container"
             style="display:grid; gap:6px; padding:0.75rem;
                    border:1px solid var(--border-color); border-radius:8px;
                    background:rgba(0,0,0,0.15); margin-bottom:1rem;">
        </div>

        <!-- Footer buttons -->
        <div style="display:flex; gap:0.6rem; justify-content:space-between; align-items:center;">
          <label style="display:flex; align-items:center; gap:0.4rem; font-size:0.72rem; color:var(--text-muted); cursor:pointer; user-select:none;">
            <input type="checkbox" id="grid-show-lines" checked style="cursor:pointer;">
            Show grid lines on canvas
          </label>
          <div style="display:flex; gap:0.5rem;">
            <button id="grid-clear-btn" style="padding:0.45rem 0.9rem; border-radius:6px; border:1px solid var(--border-color);
                background:none; color:var(--text-muted); cursor:pointer; font-size:0.78rem;">Clear All</button>
            <button id="grid-cancel-btn" style="padding:0.45rem 0.9rem; border-radius:6px; border:1px solid var(--border-color);
                background:none; color:var(--text-primary); cursor:pointer; font-size:0.78rem;">Cancel</button>
            <button id="grid-apply-btn" style="padding:0.45rem 1.1rem; border-radius:6px; border:none;
                background:var(--secondary); color:white; cursor:pointer; font-size:0.78rem; font-weight:700;">
                ✓ Apply Grid
            </button>
          </div>
        </div>
      </div>
    `;

    // Wire controls
    modal.querySelector('#grid-modal-close').addEventListener('click', closeGridModal);
    modal.querySelector('#grid-cancel-btn').addEventListener('click', closeGridModal);

    modal.querySelector('#grid-clear-btn').addEventListener('click', () => {
        state.gridLayout.cells = {};
        renderGridModalCells();
    });

    modal.querySelector('#grid-apply-btn').addEventListener('click', applyGridLayout);

    ['#grid-rows', '#grid-cols'].forEach(sel => {
        modal.querySelector(sel).addEventListener('input', () => {
            state.gridLayout.rows = Math.max(1, parseInt(modal.querySelector('#grid-rows').value) || 1);
            state.gridLayout.cols = Math.max(1, parseInt(modal.querySelector('#grid-cols').value) || 1);
            renderGridModalCells();
        });
    });

    modal.querySelector('#grid-show-lines').addEventListener('change', (e) => {
        state.gridLayout.showLines = e.target.checked;
        redraw();
    });

    // Close on backdrop click
    modal.addEventListener('click', (e) => { if (e.target === modal) closeGridModal(); });

    return modal;
}

/** Re-render the cell grid inside the modal. */
function renderGridModalCells() {
    const { rows, cols, cells } = state.gridLayout;
    const container = document.getElementById('grid-cell-container');
    if (!container) return;

    container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    container.innerHTML = '';

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const key = `${r},${c}`;
            const assignedId = cells[key];
            const assignedImg = assignedId ? state.images.find(i => i.id === assignedId) : null;

            const cell = document.createElement('div');
            const isAssigned = !!assignedImg;
            cell.style.cssText = `
                position:relative; border-radius:6px; aspect-ratio:4/3;
                display:flex; flex-direction:column; align-items:center; justify-content:center;
                cursor:pointer; overflow:hidden; transition:border-color 0.15s, opacity 0.15s;
                border:2px ${isAssigned ? 'solid' : 'dashed'} ${isAssigned ? 'var(--secondary)' : 'var(--border-color)'};
                background:rgba(0,0,0,${isAssigned ? '0' : '0.2'});
            `;
            cell.title = `Cell R${r + 1}C${c + 1} — click to assign`;

            if (assignedImg) {
                cell.innerHTML = `
                    <img src="${assignedImg.dataUrl}" style="width:100%;height:100%;object-fit:cover;opacity:0.82;">
                    <div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.65);
                                padding:2px 5px;font-size:0.58rem;color:white;
                                white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        R${r+1}C${c+1} · ${assignedImg.name}
                    </div>
                    <button class="grid-cell-clear" title="Remove assignment"
                        style="position:absolute;top:3px;right:3px;background:rgba(239,68,68,0.85);
                               border:none;color:white;border-radius:50%;width:18px;height:18px;
                               font-size:0.7rem;cursor:pointer;line-height:1;">&times;</button>
                `;
                cell.querySelector('.grid-cell-clear').addEventListener('click', (e) => {
                    e.stopPropagation();
                    delete state.gridLayout.cells[key];
                    renderGridModalCells();
                });
            } else {
                cell.innerHTML = `
                    <div style="font-size:1.6rem;color:var(--text-muted);line-height:1;">+</div>
                    <div style="font-size:0.62rem;color:var(--text-muted);margin-top:0.2rem;">R${r+1}C${c+1}</div>
                `;
            }

            cell.addEventListener('click', () => showCellAssignMenu(r, c, cell));
            container.appendChild(cell);
        }
    }
}

/** Show a dropdown for assigning an image (upload new or pick existing) to a grid cell. */
function showCellAssignMenu(row, col, cellEl) {
    const key = `${row},${col}`;
    const existing = document.getElementById('cell-assign-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'cell-assign-menu';
    menu.style.cssText = `
        position:fixed; z-index:3000; background:var(--bg-panel-solid);
        border:1px solid var(--border-color); border-radius:8px;
        box-shadow:0 8px 28px rgba(0,0,0,0.5); padding:0.3rem 0;
        min-width:210px; max-height:320px; overflow-y:auto;
    `;

    const rect = cellEl.getBoundingClientRect();
    let top = rect.bottom + 6;
    let left = rect.left;
    if (top + 250 > window.innerHeight) top = rect.top - 250;
    if (left + 220 > window.innerWidth)  left = window.innerWidth - 224;
    menu.style.top  = `${Math.max(4, top)}px`;
    menu.style.left = `${Math.max(4, left)}px`;

    const makeItem = (html, onClick) => {
        const el = document.createElement('div');
        el.style.cssText = `padding:0.4rem 0.75rem; cursor:pointer; font-size:0.75rem; color:var(--text-primary);`;
        el.innerHTML = html;
        el.addEventListener('mouseenter', () => el.style.background = 'rgba(255,255,255,0.07)');
        el.addEventListener('mouseleave', () => el.style.background = '');
        el.addEventListener('click', () => { menu.remove(); onClick(); });
        return el;
    };

    const makeSep = (label) => {
        const d = document.createElement('div');
        d.style.cssText = `padding:0.2rem 0.75rem; font-size:0.63rem; color:var(--text-muted);
                           border-top:1px solid var(--border-color); margin-top:0.15rem;`;
        d.textContent = label;
        return d;
    };

    // Upload new image for this cell
    menu.appendChild(makeItem('📁 &nbsp;Upload new image…', () => {
        const fi = document.createElement('input');
        fi.type = 'file';
        fi.accept = 'image/*';
        fi.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                const tmpImg = new Image();
                tmpImg.src = ev.target.result;
                tmpImg.onload = () => {
                    const newId = `img_grid_${Date.now()}`;
                    const newObj = {
                        id: newId,
                        name: file.name,
                        dataUrl: ev.target.result,
                        width: tmpImg.naturalWidth,
                        height: tmpImg.naturalHeight,
                        scaleRatio: 1.0,
                        scaleDistance: 10,
                        origin: { x: Math.round(tmpImg.naturalWidth / 2), y: Math.round(tmpImg.naturalHeight / 2) },
                        yAxisInverted: true,
                        flakes: [],
                        offset: { x: 0, y: 0 },
                        imageEl: tmpImg
                    };
                    state.images.push(newObj);
                    state.gridLayout.cells[key] = newId;
                    renderSubstrateList();
                    renderGridModalCells();
                    showToast(`Loaded: ${file.name} → R${row+1}C${col+1}`, 'success');
                };
            };
            reader.readAsDataURL(file);
        });
        fi.click();
    }));

    // Assign from existing images
    if (state.images.length > 0) {
        menu.appendChild(makeSep('Assign existing image:'));
        state.images.forEach(img => {
            const item = makeItem(
                `<span style="display:flex;align-items:center;gap:0.5rem;">
                   <img src="${img.dataUrl}" style="width:34px;height:26px;object-fit:cover;border-radius:3px;flex-shrink:0;">
                   <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${img.name}</span>
                 </span>`,
                () => {
                    state.gridLayout.cells[key] = img.id;
                    renderGridModalCells();
                }
            );
            menu.appendChild(item);
        });
    }

    document.body.appendChild(menu);

    const closeOnOutside = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', closeOnOutside, true);
        }
    };
    setTimeout(() => document.addEventListener('click', closeOnOutside, true), 10);
}

/** Read modal inputs, apply offsets, set enabled = true. */
function applyGridLayout() {
    const modal = document.getElementById('grid-modal');
    if (modal) {
        state.gridLayout.rows     = Math.max(1, parseInt(modal.querySelector('#grid-rows').value)  || 1);
        state.gridLayout.cols     = Math.max(1, parseInt(modal.querySelector('#grid-cols').value)  || 1);
        state.gridLayout.gapX     = parseInt(modal.querySelector('#grid-gap-x').value) || 0;
        state.gridLayout.gapY     = parseInt(modal.querySelector('#grid-gap-y').value) || 0;
        state.gridLayout.showLines = modal.querySelector('#grid-show-lines').checked;
    }

    state.gridLayout.enabled = true;
    recalcGridOffsets();
    closeGridModal();

    renderSubstrateList();

    // If no image is active yet, load the first assigned one
    if (!state.activeImageId && Object.keys(state.gridLayout.cells).length > 0) {
        const firstId = state.gridLayout.cells[Object.keys(state.gridLayout.cells)[0]];
        if (firstId) loadImage(firstId);
    } else {
        redraw();
    }

    const assignedCount = Object.keys(state.gridLayout.cells).length;
    const total = state.gridLayout.rows * state.gridLayout.cols;
    showToast(`Grid layout applied: ${state.gridLayout.rows}×${state.gridLayout.cols}, ${assignedCount}/${total} cells filled`, 'success');
}

// ----------------------------------------------------
// Image Upload Handlers
// ----------------------------------------------------

function handleImageUpload(e) {
    const files = e.target.files;
    if (files.length === 0) return;
    
    for(let i=0; i<files.length; i++) {
        const file = files[i];
        const reader = new FileReader();
        
        reader.onload = (event) => {
            const tempImg = new Image();
            tempImg.src = event.target.result;
            tempImg.onload = () => {
                let offsetX = 0;
                let offsetY = 0;
                if (state.images.length > 0) {
                    const lastImg = state.images[state.images.length - 1];
                    offsetX = (lastImg.offset ? lastImg.offset.x : 0) + lastImg.width + 50;
                    offsetY = lastImg.offset ? lastImg.offset.y : 0;
                }
                
                const newImgObj = {
                    id: `img_${Date.now()}_${i}`,
                    name: file.name,
                    dataUrl: event.target.result,
                    width: tempImg.naturalWidth,
                    height: tempImg.naturalHeight,
                    scaleRatio: 1.0, // Default 1px = 1um
                    scaleDistance: 10,
                    origin: { x: Math.round(tempImg.naturalWidth / 2), y: Math.round(tempImg.naturalHeight / 2) },
                    yAxisInverted: true,
                    flakes: [],
                    offset: { x: offsetX, y: offsetY },
                    imageEl: tempImg
                };
                
                state.images.push(newImgObj);
                loadImage(newImgObj.id);
                showToast(`Loaded: ${file.name}`, 'success');
            };
        };
        
        reader.readAsDataURL(file);
    }
}

// ----------------------------------------------------
// Data Exports: CSV, JSON (Session), PDF reports
// ----------------------------------------------------

function exportCSV() {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj || imgObj.flakes.length === 0) {
        showToast("No flakes available to export. Measure some flakes first!", "warning");
        return;
    }
    
    let csv = 'FlakeID,Name,Centroid_X_um,Centroid_Y_um,Length_um,Width_um,AspectRatio,Area_um2,Orientation_deg,Layers,RelContrast,Tag,Notes\n';

    imgObj.flakes.forEach(f => {
        const aspect = (f.length / f.width).toFixed(3);
        const layers = f.layers != null ? f.layers : '';
        const relC   = f.relContrast != null ? f.relContrast.toFixed(4) : '';
        const notes  = (f.notes || '').replace(/"/g, '""'); // escape quotes
        csv += `"${f.id}","${f.name}",${f.x_um.toFixed(4)},${f.y_um.toFixed(4)},${f.length.toFixed(3)},${f.width.toFixed(3)},${aspect},${f.area.toFixed(3)},${f.orientation},${layers},${relC},"${f.customTag}","${notes}"\n`;
    });
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    
    const baseName = imgObj.name.substring(0, imgObj.name.lastIndexOf('.')) || imgObj.name;
    link.setAttribute('href', url);
    link.setAttribute('download', `${baseName}_FlakeMetrics.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showToast("CSV data exported successfully", "success");
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKUP v2 — saves everything needed for a perfect session restore:
//   • All images with their full base64 dataUrl (so images re-appear without
//     re-uploading files)
//   • All detected/drawn flakes with every metric, tag, notes, color, points
//   • Per-image calibration: scaleRatio, scaleDistance, origin, yAxisInverted,
//     offset (stitch position)
//   • Global detection filters (threshold, tolerance, minSize, colorMode, …)
//   • Ignore areas drawn on the canvas
//   • Grid layout configuration
//   • Which image was active when the backup was made
//
// The imageEl DOM property is stripped before serialisation (non-serialisable)
// and recreated from dataUrl on restore via preloadAllImages().
// ─────────────────────────────────────────────────────────────────────────────
function exportJSON() {
    // Flush current image's live scale/origin back into its imgObj
    updateActiveImageConfig();

    // Strip non-serialisable DOM Image elements
    const imagesPayload = state.images.map(({ imageEl, ...rest }) => rest);

    const totalFlakes = state.images.reduce((s, img) => s + img.flakes.length, 0);

    const backup = {
        version: 2,
        appName: 'FlakeLocator Pro',
        savedAt: new Date().toISOString(),
        activeImageId: state.activeImageId,
        filters: { ...state.filters },
        ignoreAreas: JSON.parse(JSON.stringify(state.ignoreAreas)),
        gridLayout: JSON.parse(JSON.stringify(state.gridLayout)),
        images: imagesPayload
    };

    // Compact JSON — no indentation keeps file size small (images are already
    // base64 so pretty-print would just add millions of useless newlines)
    const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    link.setAttribute('href', url);
    link.setAttribute('download', `FlakeLocator_Backup_${date}.json`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showToast(
        `Backup saved — ${state.images.length} image(s), ${totalFlakes} flake(s)`,
        'success'
    );
}

function handleJSONImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = ''; // allow re-importing the same file later

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const raw = JSON.parse(event.target.result);

            // ── Normalise v1 (legacy: raw array) vs v2 (object with metadata) ──
            let images, activeImageId, savedFilters, savedIgnoreAreas, savedGridLayout;

            if (Array.isArray(raw)) {
                // v1 — just an array of image objects, no global state
                images          = raw;
                activeImageId   = raw[0]?.id ?? null;
                savedFilters    = null;
                savedIgnoreAreas = [];
                savedGridLayout  = null;
            } else if (raw && raw.version === 2 && Array.isArray(raw.images)) {
                images           = raw.images;
                activeImageId    = raw.activeImageId ?? images[0]?.id ?? null;
                savedFilters     = raw.filters     ?? null;
                savedIgnoreAreas = raw.ignoreAreas ?? [];
                savedGridLayout  = raw.gridLayout  ?? null;
            } else {
                throw new Error('Unrecognised backup format (expected v1 array or v2 object)');
            }

            if (!images.length) throw new Error('Backup contains no images');

            // ── Validate every image object has required fields ────────────────
            const required = ['id', 'name', 'dataUrl', 'flakes', 'scaleRatio', 'origin'];
            const valid = images.every(img =>
                required.every(f => Object.prototype.hasOwnProperty.call(img, f))
            );
            if (!valid) throw new Error('One or more images are missing required fields');

            // ── Restore global filter state ───────────────────────────────────
            if (savedFilters) {
                Object.assign(state.filters, savedFilters);
                _syncFiltersToUI();
            }

            // ── Restore ignore areas ──────────────────────────────────────────
            state.ignoreAreas = savedIgnoreAreas;

            // ── Restore grid layout ───────────────────────────────────────────
            if (savedGridLayout) {
                Object.assign(state.gridLayout, savedGridLayout);
            }

            // ── Restore images — strip any stale imageEl that survived JSON ───
            state.images = images.map(img => ({ ...img, imageEl: null }));

            // ── Re-create imageEl for every image from its stored dataUrl ─────
            // preloadAllImages() returns a Promise that resolves once every
            // Image element has fired its onload callback.
            preloadAllImages().then(() => {
                // Activate the same image that was open when the backup was saved
                const targetId =
                    (activeImageId && state.images.find(i => i.id === activeImageId))
                        ? activeImageId
                        : state.images[0].id;

                loadImage(targetId);

                const totalFlakes = state.images.reduce((s, img) => s + img.flakes.length, 0);
                showToast(
                    `Restored — ${state.images.length} image(s), ${totalFlakes} flake(s)`,
                    'success'
                );
            });

        } catch (err) {
            showToast(`Restore failed: ${err.message}`, 'error');
            console.error('[FlakeLocator] Backup restore error:', err);
        }
    };
    reader.readAsText(file);
}

/**
 * Push all values from state.filters back into the corresponding HTML
 * input elements so the UI matches the restored state immediately.
 */
function _syncFiltersToUI() {
    const f = state.filters;

    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    const setSel = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };

    // Detection sliders
    setVal('filter-threshold',          f.threshold);
    setTxt('filter-threshold-val',      f.threshold);
    setVal('filter-tolerance',          f.tolerance);
    setTxt('filter-tolerance-val',      f.tolerance);
    setVal('filter-minSize',            f.minSize);
    setTxt('filter-minSize-val',        f.minSize);
    setVal('filter-colorDistThreshold', f.colorDistThreshold);
    setTxt('filter-colorDistThreshold-val', f.colorDistThreshold);
    setVal('filter-erosionKernel',      f.erosionKernel);
    setTxt('filter-erosionKernel-val',  f.erosionKernel);

    // Image display sliders
    setVal('filter-contrast',           f.contrast);
    setTxt('filter-contrast-val',       f.contrast.toFixed ? f.contrast.toFixed(1) : f.contrast);
    setVal('filter-brightness',         f.brightness);
    setTxt('filter-brightness-val',     f.brightness.toFixed ? f.brightness.toFixed(1) : f.brightness);

    // Selects
    setSel('filter-colorMode', f.colorMode);

    // Checkboxes
    setChk('filter-ignore-banner',    f.ignoreBanner);
    setChk('filter-show-crosshairs',  f.showCrosshairs);
    setChk('filter-show-labels',      f.showLabels);
    setChk('filter-watershed-split',  f.watershedSplit);
    setChk('filter-morphological',    f.morphCleanup);

    // Show/hide the morphology kernel group based on restored value
    const kernelGroup = document.getElementById('morphology-kernel-group');
    if (kernelGroup) kernelGroup.style.display = f.morphCleanup ? 'block' : 'none';

    // Show/hide color-distance slider group and grayscale threshold group
    const colorDistGroup = document.getElementById('colorDist-group');
    const grayGroup      = document.getElementById('grayscale-threshold-group');
    if (colorDistGroup) colorDistGroup.style.display = (f.colorMode === 'colorDist') ? 'block' : 'none';
    if (grayGroup)      grayGroup.style.display      = (f.colorMode === 'colorDist') ? 'none'  : 'block';
}

// Visual Floating Alert system
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) {
        const div = document.createElement('div');
        div.id = 'toast-container';
        document.body.appendChild(div);
    }
    
    const toast = document.createElement('div');
    toast.className = `toast active ${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'warning') icon = '⚠️';
    if (type === 'error') icon = '🚨';
    
    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    document.getElementById('toast-container').appendChild(toast);
    
    setTimeout(() => {
        toast.classList.remove('active');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 3500);
}

// ============================================================
// SUBSTRATE ANALYTICAL REPORT
// ============================================================

/** Builds a clean, print-friendly HTML string for the report */
function _buildReportHTML(imgObj) {
    const flakes = imgObj.flakes;
    const n = flakes.length;
    if (n === 0) return '<p style="color:#64748b;text-align:center;padding:2rem;">No flakes annotated yet.</p>';

    const mean = arr => arr.reduce((a,b)=>a+b,0) / arr.length;
    const areas   = flakes.map(f=>f.area||0);
    const lengths = flakes.map(f=>f.length||0);
    const widths  = flakes.map(f=>f.width||0);
    const aspects = flakes.map(f=>f.length/Math.max(f.width,0.001));
    const sr = imgObj.scaleRatio || (state.images.find(i=>i.id===imgObj.id)||{}).scaleRatio || 1;
    const imgAreaUm = ((imgObj.width||1)*(imgObj.height||1)) / (sr*sr);
    const totalFlakeArea = areas.reduce((a,b)=>a+b,0);
    const coverage = imgAreaUm > 0 ? (totalFlakeArea/imgAreaUm*100) : 0;

    // Per-layer tally
    const tagOrder = ['Monolayer','Bilayer','Trilayer','Few-Layer','Thick Flake','Residue'];
    const tagCounts = {}, tagColors = {};
    flakes.forEach(f => {
        tagCounts[f.customTag] = (tagCounts[f.customTag]||0)+1;
        tagColors[f.customTag] = f.color||'#6b7280';
    });
    const allTags = [...new Set([...tagOrder,...Object.keys(tagCounts)])].filter(t=>tagCounts[t]>0);

    const layerRows = allTags.map(tag => {
        const g = flakes.filter(f=>f.customTag===tag), m = g.length;
        const cg = g.filter(f=>f.relContrast!=null);
        return `<tr>
            <td style="padding:5px 8px;"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${tagColors[tag]||'#6b7280'};margin-right:6px;vertical-align:middle;"></span>${tag}</td>
            <td style="padding:5px 8px;text-align:center;">${m}</td>
            <td style="padding:5px 8px;text-align:center;">${(m/n*100).toFixed(1)}%</td>
            <td style="padding:5px 8px;text-align:right;">${(g.reduce((s,f)=>s+f.area,0)/m).toFixed(1)}</td>
            <td style="padding:5px 8px;text-align:right;">${(g.reduce((s,f)=>s+f.length,0)/m).toFixed(1)}</td>
            <td style="padding:5px 8px;text-align:right;">${cg.length?(cg.reduce((s,f)=>s+f.relContrast,0)/cg.length*100).toFixed(1):'—'}</td>
        </tr>`;
    }).join('');

    const flakeRows = flakes.map((f,i) => `
        <tr style="background:${i%2?'#f8fafc':'#fff'}">
            <td style="padding:4px 6px;font-family:monospace;font-size:11px;">${f.name}</td>
            <td style="padding:4px 6px;text-align:right;">${f.x_um.toFixed(3)}</td>
            <td style="padding:4px 6px;text-align:right;">${f.y_um.toFixed(3)}</td>
            <td style="padding:4px 6px;text-align:right;">${f.length.toFixed(2)}</td>
            <td style="padding:4px 6px;text-align:right;">${f.width.toFixed(2)}</td>
            <td style="padding:4px 6px;text-align:right;">${(f.length/Math.max(f.width,0.001)).toFixed(2)}</td>
            <td style="padding:4px 6px;text-align:right;">${f.area.toFixed(1)}</td>
            <td style="padding:4px 6px;text-align:center;">${f.orientation}°</td>
            <td style="padding:4px 6px;">${f.customTag}</td>
            <td style="padding:4px 6px;text-align:right;">${f.relContrast!=null?(f.relContrast*100).toFixed(1)+'%':'—'}</td>
        </tr>`).join('');

    const th = s => `<th style="padding:5px 8px;background:#1e293b;color:#94a3b8;font-size:11px;font-weight:600;text-align:right;white-space:nowrap;">${s}</th>`;
    const thL = s => `<th style="padding:5px 8px;background:#1e293b;color:#94a3b8;font-size:11px;font-weight:600;text-align:left;white-space:nowrap;">${s}</th>`;

    return `
    <div style="font-family:'Segoe UI',Arial,sans-serif;color:#1e293b;line-height:1.5;">
        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #10b981;padding-bottom:10px;margin-bottom:18px;">
            <div>
                <div style="font-size:20px;font-weight:800;letter-spacing:-0.02em;">Substrate Analytical Report</div>
                <div style="font-size:12px;color:#64748b;margin-top:2px;">FlakeLocator Pro — 2D Material Analysis</div>
            </div>
            <div style="text-align:right;font-size:11px;color:#64748b;">
                <div>${new Date().toLocaleString()}</div>
                <div style="font-weight:600;color:#1e293b;">${imgObj.name}</div>
            </div>
        </div>

        <!-- Summary chips -->
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:18px;">
            ${[
                ['Total Flakes',n,'#10b981'],
                ['Avg Area',mean(areas).toFixed(1)+' µm<sup>2</sup>','#06b6d4'],
                ['Avg Length',mean(lengths).toFixed(1)+' µm','#a855f7'],
                ['Avg Aspect',mean(aspects).toFixed(2),'#f59e0b'],
                ['Coverage',coverage.toFixed(2)+'%','#ef4444'],
            ].map(([lbl,val,col])=>`
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;text-align:center;">
                    <div style="font-size:18px;font-weight:800;color:${col};">${val}</div>
                    <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">${lbl}</div>
                </div>`).join('')}
        </div>

        <!-- Calibration info -->
        <div style="background:#f1f5f9;border-radius:6px;padding:10px 14px;margin-bottom:18px;font-size:12px;display:flex;gap:24px;">
            <span>Scale: <strong>${sr.toFixed(3)} px/µm</strong></span>
            <span>Origin: <strong>(${state.origin.x}, ${state.origin.y}) px</strong></span>
            <span>Image: <strong>${imgObj.width||'?'} × ${imgObj.height||'?'} px</strong></span>
        </div>

        <!-- Per-layer table -->
        <div style="font-size:13px;font-weight:700;margin-bottom:6px;color:#0f172a;">Layer Classification Summary</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px;">
            <thead><tr>
                ${thL('Layer')}${th('Count')}${th('%')}${th('Avg Area (µm<sup>2</sup>)')}${th('Avg Length (µm)')}${th('Avg Contrast (%)')}
            </tr></thead>
            <tbody>${layerRows}</tbody>
        </table>

        <!-- Full flake table -->
        <div style="font-size:13px;font-weight:700;margin-bottom:6px;color:#0f172a;">Complete Flake Inventory</div>
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
            <thead><tr>
                ${thL('Name')}${th('X (µm)')}${th('Y (µm)')}${th('L (µm)')}${th('W (µm)')}${th('AR')}${th('Area (µm<sup>2</sup>)')}${th('Angle')}${thL('Tag')}${th('Contrast')}
            </tr></thead>
            <tbody>${flakeRows}</tbody>
        </table>
    </div>`;
}

function showReportModal() {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj) { showToast('No active image', 'warning'); return; }

    const overlay = document.getElementById('report-modal');
    overlay.classList.add('active');
    document.getElementById('report-modal-body').innerHTML = _buildReportHTML(imgObj);
}

/** Open the report in a clean new window and trigger browser print-to-PDF */
function exportReportPDF() {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj) { showToast('No active image', 'warning'); return; }

    const content = _buildReportHTML(imgObj);
    const win = window.open('', '_blank', 'width=900,height=700');
    win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
        <title>Substrate Analytical Report — ${imgObj.name}</title>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { font-family: 'Segoe UI', Arial, sans-serif; color: #1e293b;
                   background: #fff; padding: 24px; max-width: 1100px; margin: auto; }
            @media print {
                body { padding: 0; }
                @page { margin: 15mm 12mm; size: A4 landscape; }
            }
            table { page-break-inside: auto; }
            tr { page-break-inside: avoid; page-break-after: auto; }
            thead { display: table-header-group; }
            .no-print { display: none; }
        </style>
    </head><body>
        <div class="no-print" style="text-align:right;margin-bottom:12px;">
            <button onclick="window.print()" style="padding:8px 18px;background:#10b981;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-weight:600;">
                🖨 Print / Save as PDF
            </button>
        </div>
        ${content}
    </body></html>`);
    win.document.close();
    win.focus();
}
window.exportReportPDF = exportReportPDF;

/** Export report data as an Excel SpreadsheetML file */
function exportReportExcel() {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj || !imgObj.flakes.length) { showToast('No flake data to export', 'warning'); return; }
    _exportFlakesToExcel(imgObj.flakes, imgObj.name);
}
window.exportReportExcel = exportReportExcel;

/** Standalone Excel export from the header button */
function exportExcel() {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj || !imgObj.flakes.length) {
        showToast('No flakes available to export. Detect or annotate flakes first.', 'warning');
        return;
    }
    _exportFlakesToExcel(imgObj.flakes, imgObj.name);
}

/**
 * Core Excel builder using SheetJS (xlsx.full.min.js loaded in index.html).
 * Produces a real .xlsx file with column widths, a frozen header row, and
 * bold navy header styling — opens natively in Excel, LibreOffice, and Numbers.
 */
function _exportFlakesToExcel(flakes, baseName) {
    if (typeof XLSX === 'undefined') {
        showToast('SheetJS library not loaded — check your internet connection and reload.', 'error');
        return;
    }

    // ── Build data rows ──────────────────────────────────────────────────────
    const headers = [
        'Name', 'X (µm)', 'Y (µm)', 'Length (µm)', 'Width (µm)',
        'Aspect Ratio', 'Area (µm²)', 'Orientation (°)', 'Tag',
        'Rel. Contrast (%)', 'Layers', 'Notes'
    ];

    const rows = flakes.map(f => [
        f.name,
        f.x_um   != null ? +f.x_um.toFixed(4)   : '',
        f.y_um   != null ? +f.y_um.toFixed(4)    : '',
        f.length != null ? +f.length.toFixed(3)  : '',
        f.width  != null ? +f.width.toFixed(3)   : '',
        f.width  > 0     ? +(f.length / f.width).toFixed(3) : '',
        f.area   != null ? +f.area.toFixed(3)    : '',
        f.orientation != null ? +f.orientation   : '',
        f.customTag || '',
        f.relContrast != null ? +(f.relContrast * 100).toFixed(2) : '',
        f.layers != null ? +f.layers : '',
        f.notes || ''
    ]);

    // ── Create worksheet from array-of-arrays ────────────────────────────────
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

    // Column widths (characters)
    ws['!cols'] = [
        { wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 10 },
        { wch: 11 }, { wch: 11 }, { wch: 14 }, { wch: 14 },
        { wch: 16 }, { wch: 8  }, { wch: 24 }
    ];

    // Freeze the header row
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };

    // Note: cell styles (.s) require the Pro/paid SheetJS build.
    // Community edition ignores them — header formatting is not applied.

    // ── Summary sheet ────────────────────────────────────────────────────────
    const imgObj = state.images.find(img => img.flakes === flakes) ||
                   state.images.find(img => img.id === state.activeImageId);
    const sr = imgObj ? (imgObj.scaleRatio || 1) : 1;
    const imgAreaUm = imgObj ? (imgObj.width * imgObj.height) / (sr * sr) : 0;
    const totalFlakeArea = flakes.reduce((s, f) => s + (f.area || 0), 0);
    const coverage = imgAreaUm > 0 ? (totalFlakeArea / imgAreaUm * 100) : 0;
    const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const tagCounts = {};
    flakes.forEach(f => { tagCounts[f.customTag] = (tagCounts[f.customTag] || 0) + 1; });

    const summaryData = [
        ['Metric', 'Value'],
        ['Image', imgObj ? imgObj.name : '—'],
        ['Generated', new Date().toLocaleString()],
        ['Scale (px/µm)', sr.toFixed(3)],
        [''],
        ['Total Flakes', flakes.length],
        ['Avg Area (µm²)', mean(flakes.map(f => f.area || 0)).toFixed(2)],
        ['Avg Length (µm)', mean(flakes.map(f => f.length || 0)).toFixed(2)],
        ['Avg Width (µm)', mean(flakes.map(f => f.width || 0)).toFixed(2)],
        ['Avg Aspect Ratio', mean(flakes.map(f => f.length / Math.max(f.width || 0.001, 0.001))).toFixed(3)],
        ['Coverage (%)', coverage.toFixed(2)],
        [''],
        ['Layer', 'Count', '% of Total'],
        ...Object.entries(tagCounts).map(([tag, count]) =>
            [tag, count, +(count / flakes.length * 100).toFixed(1)]
        )
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    wsSummary['!cols'] = [{ wch: 20 }, { wch: 18 }, { wch: 12 }];

    // ── Assemble workbook ────────────────────────────────────────────────────
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');
    XLSX.utils.book_append_sheet(wb, ws, 'Flake Data');

    const fileName = (baseName.replace(/\.[^.]+$/, '') || 'FlakeData') + '_FlakeMetrics.xlsx';
    // Explicitly set bookType to 'xlsx' — prevents SheetJS from inferring a
    // wrong format from the filename and producing a mismatched .xls file.
    XLSX.writeFile(wb, fileName, { bookType: 'xlsx', type: 'binary' });
    showToast(`Excel file exported: ${fileName}`, 'success');
}

function closeReportModal() {
    document.getElementById('report-modal').classList.remove('active');
}

// ----------------------------------------------------
// Metrology & Auto-Scale Bar Detection
// ----------------------------------------------------

// ── Scale Bar Detection ───────────────────────────────────────────────────────
// Handles the common "dark banner with white text + line" style as well as
// plain white-bar-on-dark-substrate styles.

function autoDetectScaleBar() {
    if (!loadedImageEl) return null;
    const w = offscreenCanvas.width, h = offscreenCanvas.height;
    const tc = document.createElement('canvas');
    tc.width = w; tc.height = h;
    const tx = tc.getContext('2d');
    tx.drawImage(loadedImageEl, 0, 0);
    let imgData;
    try { imgData = tx.getImageData(0, 0, w, h).data; }
    catch(e) { return null; }

    // ── Step 1: sample mean luminance of upper 70% as reference ──────────────
    let refLum = 0, refN = 0;
    for (let y = 0; y < Math.round(h * 0.7); y += 6) {
        for (let x = 0; x < w; x += 6) {
            const i = (y * w + x) * 4;
            refLum += 0.299*imgData[i] + 0.587*imgData[i+1] + 0.114*imgData[i+2];
            refN++;
        }
    }
    refLum /= refN;

    // ── Step 2: locate the banner zone (bottom rows that look like a caption bar)
    // A banner row: mean luminance deviates from reference by > 25, OR very uniform
    const scanTop = Math.round(h * 0.78);
    let bannerTop = h;
    for (let y = scanTop; y < h; y++) {
        let rowLum = 0, rowMin = 255, rowMax = 0;
        for (let x = 0; x < w; x += 4) {
            const i = (y * w + x) * 4;
            const lum = 0.299*imgData[i] + 0.587*imgData[i+1] + 0.114*imgData[i+2];
            rowLum += lum; rowMin = Math.min(rowMin, lum); rowMax = Math.max(rowMax, lum);
        }
        rowLum /= Math.ceil(w / 4);
        const range = rowMax - rowMin;
        // Dark banner: row is considerably darker than image mean AND relatively uniform
        if (rowLum < refLum * 0.75 && range < 120) {
            bannerTop = Math.min(bannerTop, y);
        }
    }
    // Also consider full bottom 15% if no banner found
    const searchTop = bannerTop < h ? bannerTop : Math.round(h * 0.85);

    // ── Step 3: find bright horizontal runs within the search zone ───────────
    // Collect all contiguous bright (lum > 180) runs on each row
    const runs = [];
    for (let y = searchTop; y < h; y++) {
        let start = -1, len = 0;
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const lum = 0.299*imgData[i] + 0.587*imgData[i+1] + 0.114*imgData[i+2];
            const bright = lum > 175;
            if (bright) { if (start < 0) start = x; len++; }
            else {
                if (len >= 20 && len < w * 0.92) runs.push({ y, startX: start, length: len });
                start = -1; len = 0;
            }
        }
        if (len >= 20 && len < w * 0.92) runs.push({ y, startX: start, length: len });
    }

    if (!runs.length) return null;

    // ── Step 4: score runs — prefer runs that are:
    //   (a) in the banner zone, (b) not the text (text is short & fragmented),
    //   (c) horizontally thick (multiple consecutive y rows at same x-range)
    // Group runs by approximate x-position and length to find "thick bars"
    const grouped = {};
    runs.forEach(r => {
        const key = `${Math.round(r.startX/8)}_${Math.round(r.length/8)}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(r);
    });

    let best = null, bestScore = 0;
    Object.values(grouped).forEach(group => {
        if (group.length === 0) return;
        const avgLen = group.reduce((s,r) => s+r.length,0) / group.length;
        const thickness = group.length; // number of rows
        const inBanner = group[0].y >= bannerTop ? 2 : 1;
        // Score: longer bar, thicker bar, in banner zone
        const score = avgLen * Math.sqrt(thickness) * inBanner;
        if (score > bestScore) {
            bestScore = score;
            // Use the middle row of the group as the representative
            best = group[Math.floor(group.length / 2)];
        }
    });

    if (!best) return null;
    return { ...best, bannerTop: bannerTop < h ? bannerTop : Math.round(h * 0.85) };
}

// ── Scale Bar Verification Modal ──────────────────────────────────────────────
const SB_PRESETS = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
let _sbState = { detectedLine: null, selectedUm: null };

function runAutoScaleBarCalibration() {
    if (!loadedImageEl) { showToast('No active image loaded', 'warning'); return; }
    if (state.canvasTainted) { showToast('⚠ Pixel access blocked — use local server', 'error'); return; }

    const line = autoDetectScaleBar();
    _sbState = { detectedLine: line, selectedUm: null };

    // Populate preset buttons
    const presetsEl = document.getElementById('scalebar-presets');
    presetsEl.innerHTML = '';
    SB_PRESETS.forEach(um => {
        const btn = document.createElement('button');
        btn.className = 'sb-preset-btn';
        btn.textContent = um < 1 ? `${um} µm` : `${um} µm`;
        btn.dataset.um = um;
        btn.onclick = () => {
            document.querySelectorAll('.sb-preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _sbState.selectedUm = um;
            document.getElementById('scalebar-custom-input').value = um;
            updateScaleBarPreview();
        };
        presetsEl.appendChild(btn);
    });

    // Info row
    const infoEl = document.getElementById('scalebar-info-row');
    if (line) {
        infoEl.innerHTML = `<b style="color:var(--primary);">Scale bar detected</b> —
            <span style="font-family:var(--font-mono);">${line.length} px</span> wide at
            y = <span style="font-family:var(--font-mono);">${line.y}</span>.
            Select its physical length below to set calibration.`;
    } else {
        infoEl.innerHTML = `<b style="color:var(--warning);">No scale bar auto-detected.</b>
            Showing bottom region — draw a mental reference and enter pixel width manually,
            or use the <b>Calibrate</b> ruler tool for manual line drawing.`;
    }

    document.getElementById('scalebar-custom-input').value = '';
    document.getElementById('scalebar-result-row').style.display = 'none';
    document.getElementById('scalebar-apply-btn').disabled = true;

    document.getElementById('scalebar-modal').classList.add('active');
    setTimeout(_drawScaleBarPreview, 50);
}

function _drawScaleBarPreview() {
    if (!loadedImageEl) return;
    const cvs = document.getElementById('scalebar-preview-canvas');
    const line = _sbState.detectedLine;

    const iw = loadedImageEl.naturalWidth, ih = loadedImageEl.naturalHeight;
    // Show bottom 22% of the image
    const stripH = Math.round(ih * 0.22);
    const stripY = ih - stripH;
    const maxW = cvs.parentElement.clientWidth - 2;
    const scale = Math.min(maxW / iw, 160 / stripH);

    cvs.width  = Math.round(iw * scale);
    cvs.height = Math.round(stripH * scale);
    const ctx2 = cvs.getContext('2d');

    ctx2.drawImage(loadedImageEl, 0, stripY, iw, stripH, 0, 0, cvs.width, cvs.height);

    // Highlight detected bar
    if (line) {
        const drawY = (line.y - stripY) * scale;
        const drawX = line.startX * scale;
        const drawW = line.length * scale;

        // Green highlight rect around the bar (±4px)
        ctx2.strokeStyle = '#10b981';
        ctx2.lineWidth = 2;
        ctx2.setLineDash([]);
        ctx2.strokeRect(drawX - 2, drawY - 4, drawW + 4, 10);

        // Arrow / label
        ctx2.fillStyle = '#10b981';
        ctx2.font = `bold ${Math.max(10, 12 * scale)}px Inter, sans-serif`;
        ctx2.fillText(`← ${line.length} px →`, drawX, drawY - 7);
    }

    // Status bar
    const status = document.getElementById('scalebar-status-bar');
    status.innerHTML = line
        ? `✓ Bar: ${line.length} px · x=${line.startX}–${line.startX+line.length} · y=${line.y}`
        : '⚠ No bar auto-detected — bottom region shown for reference';
}

function updateScaleBarPreview() {
    const um = parseFloat(document.getElementById('scalebar-custom-input').value);
    const line = _sbState.detectedLine;
    const resultEl = document.getElementById('scalebar-result-row');
    const applyBtn = document.getElementById('scalebar-apply-btn');

    if (isNaN(um) || um <= 0) {
        resultEl.style.display = 'none';
        applyBtn.disabled = true;
        _sbState.selectedUm = null;
        return;
    }
    _sbState.selectedUm = um;

    // Sync preset buttons
    document.querySelectorAll('.sb-preset-btn').forEach(b => {
        b.classList.toggle('active', parseFloat(b.dataset.um) === um);
    });

    if (line) {
        const ratio = line.length / um;
        resultEl.style.display = 'block';
        resultEl.innerHTML = `${line.length} px ÷ ${um} µm = <b>${ratio.toFixed(4)} px/µm</b>`;
        applyBtn.disabled = false;
    } else {
        resultEl.style.display = 'block';
        resultEl.innerHTML = `⚠ No bar detected — cannot compute ratio without pixel width.`;
        applyBtn.disabled = true;
    }
}

function applyScaleBarModal() {
    const { detectedLine, selectedUm } = _sbState;
    if (!detectedLine || !selectedUm || selectedUm <= 0) return;

    const ratio = detectedLine.length / selectedUm;
    state.scaleDistance = selectedUm;
    state.scaleRatio    = ratio;
    document.getElementById('input-scale').value = ratio.toFixed(3);
    updateActiveImageConfig();
    recalculateAllFlakes();
    renderFlakes();
    showToast(`Calibrated: ${ratio.toFixed(3)} px/µm  (${detectedLine.length} px = ${selectedUm} µm)`, 'success');

    // Highlight on canvas for 2 s
    state.highlightScaleBar = {
        startX: detectedLine.startX, y: detectedLine.y,
        length: detectedLine.length, expiresAt: Date.now() + 2000
    };
    redraw();
    setTimeout(() => { state.highlightScaleBar = null; redraw(); }, 2000);

    _registerScaleBarIgnoreArea(detectedLine);
    closeScaleBarModal();
    setTool('pan');
}

function closeScaleBarModal() {
    document.getElementById('scalebar-modal').classList.remove('active');
}

// Register the scale bar region as a persistent ignore area so auto-detect
// and flood-fill both skip it automatically.
// Detect the actual dark band extent by scanning row luminance around the
// detected line, then build a tight ignore area over just that band.
function _registerScaleBarIgnoreArea(line) {
    if (!loadedImageEl || !line) return;
    const iw = loadedImageEl.naturalWidth;
    const ih = loadedImageEl.naturalHeight;

    // Try to read pixel data to find precise band boundaries
    let bandTop = line.y, bandBottom = line.y;
    try {
        const tc  = document.createElement('canvas');
        tc.width  = iw; tc.height = ih;
        tc.getContext('2d').drawImage(loadedImageEl, 0, 0);
        const px  = tc.getContext('2d').getImageData(0, 0, iw, ih).data;

        // Mean luminance across the scale bar width for a given row
        const rowLum = y => {
            let s = 0, n = 0;
            const x0 = Math.max(0, line.startX);
            const x1 = Math.min(iw - 1, line.startX + line.length);
            for (let x = x0; x <= x1; x += 3) {
                const i = (y * iw + x) * 4;
                s += 0.299 * px[i] + 0.587 * px[i+1] + 0.114 * px[i+2];
                n++;
            }
            return n ? s / n : 128;
        };

        // The band background is dark (reddish or grey) — lum < 180.
        // Scan upward from line.y until we hit a bright row (outside the band).
        for (let y = line.y; y >= Math.max(0, line.y - 120); y--) {
            if (rowLum(y) > 185) break;
            bandTop = y;
        }
        // Scan downward from line.y until bright row.
        for (let y = line.y; y < Math.min(ih, line.y + 120); y++) {
            if (rowLum(y) > 185) break;
            bandBottom = y;
        }
    } catch(e) {
        // Canvas tainted fallback: use 17% of width
        const h2 = Math.round(line.length * 0.125);
        bandTop    = line.y - h2;
        bandBottom = line.y + h2;
    }

    const pad        = Math.round(line.length * 0.05);
    const maxHeight  = Math.round(line.length * 0.25);   // 25% of width
    const detectedH  = bandBottom - bandTop;
    const finalTop   = detectedH > 0 && detectedH <= maxHeight
                         ? bandTop  - 4
                         : line.y - Math.round(maxHeight * 0.5);
    const finalBot   = detectedH > 0 && detectedH <= maxHeight
                         ? bandBottom + 4
                         : line.y + Math.round(maxHeight * 0.5);

    const minX = Math.max(0, line.startX - pad);
    const maxX = Math.min(iw, line.startX + line.length + pad);
    const minY = Math.max(0, finalTop);
    const maxY = Math.min(ih, finalBot);

    state.ignoreAreas = state.ignoreAreas.filter(a => !a.isScaleBar);
    state.ignoreAreas.push({ minX, maxX, minY, maxY, isScaleBar: true });
    redraw();
    showToast('Scale bar region added to ignore areas', 'info');
}

// ----------------------------------------------------
// Composite JPG Exporter
// ----------------------------------------------------

function exportJPG() {
    if (state.images.length === 0) {
        showToast("No images loaded to export", "warning");
        return;
    }

    const includeOverlays = confirm("Include measurement outlines and labels in the export?");

    // Ask for scale — default 2× for high-DPI export
    const scaleInput = prompt("Export scale factor (1 = native, 2 = 2× resolution, 3 = 3× resolution):", "2");
    const SCALE = Math.min(4, Math.max(1, parseFloat(scaleInput) || 2));

    showToast(`Generating ${SCALE}× high-quality JPG…`, "info");

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    state.images.forEach(img => {
        const ox = img.offset ? img.offset.x : 0;
        const oy = img.offset ? img.offset.y : 0;
        if (ox < minX) minX = ox;
        if (ox + img.width  > maxX) maxX = ox + img.width;
        if (oy < minY) minY = oy;
        if (oy + img.height > maxY) maxY = oy + img.height;
    });

    const exportWidth  = maxX - minX;
    const exportHeight = maxY - minY;

    if (exportWidth <= 0 || exportHeight <= 0) {
        showToast("Invalid export dimensions", "error");
        return;
    }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width  = exportWidth  * SCALE;
    tempCanvas.height = exportHeight * SCALE;
    const tempCtx = tempCanvas.getContext('2d');

    // Fill white background (avoids black JPEG background)
    tempCtx.fillStyle = '#ffffff';
    tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    tempCtx.save();
    tempCtx.scale(SCALE, SCALE);
    tempCtx.translate(-minX, -minY);

    // 1. Draw all substrate images
    state.images.forEach(img => {
        tempCtx.save();
        const ox = img.offset ? img.offset.x : 0;
        const oy = img.offset ? img.offset.y : 0;
        tempCtx.translate(ox, oy);
        if (img.id === state.activeImageId && (state.filters.showBinary || state.filters.contrast !== 1.0 || state.filters.brightness !== 1.0) && filteredCanvas) {
            tempCtx.drawImage(filteredCanvas, 0, 0);
        } else if (img.imageEl) {
            tempCtx.drawImage(img.imageEl, 0, 0);
        }
        tempCtx.restore();
    });

    // 2. Draw overlays
    if (includeOverlays) {
        state.images.forEach(img => {
            if (img.origin) {
                const offset = img.offset || { x: 0, y: 0 };
                drawOriginMarkerOnCtx(tempCtx, 1.0, img.origin, offset);
            }
            drawFlakesForImage(img, tempCtx, 1.0, true);
        });
    }

    tempCtx.restore();

    try {
        if (state.canvasTainted) throw new Error('tainted');
        // JPEG quality 1.0 = maximum (no compression artefacts)
        const dataUrl = tempCanvas.toDataURL('image/jpeg', 1.0);
        const link = document.createElement('a');
        link.href     = dataUrl;
        link.download = `FlakeLocator_Export_${SCALE}x.jpg`;
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        const mp = ((tempCanvas.width * tempCanvas.height) / 1e6).toFixed(1);
        showToast(`Exported ${tempCanvas.width}×${tempCanvas.height}px (${mp} MP) at full quality`, "success");
    } catch (e) {
        console.error("Export JPG failed:", e);
        showToast("Export failed: browser security restriction (tainted canvas).", "error");
    }
}

// ----------------------------------------------------
// Snip & Crop Image Exporter
// ----------------------------------------------------

function drawTemporarySnipBox(currentGlobalPix) {
    ctx.save();
    ctx.setTransform(state.zoom, 0, 0, state.zoom, state.pan.x, state.pan.y);
    
    ctx.strokeStyle = 'rgba(236, 72, 153, 0.9)'; // Pink color for snipping crop box
    ctx.lineWidth = 2 / state.zoom;
    ctx.fillStyle = 'rgba(236, 72, 153, 0.15)';
    ctx.setLineDash([6 / state.zoom, 4 / state.zoom]);
    
    const start = state.drawingPoints[0];
    ctx.beginPath();
    ctx.rect(start.x, start.y, currentGlobalPix.x - start.x, currentGlobalPix.y - start.y);
    ctx.stroke();
    ctx.fill();
    
    ctx.restore();
}

function triggerSnipExport(minX, minY, w, h) {
    const includeOverlays = confirm("Do you want to include the measurement outlines and labels in the cropped export?");
    
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d');
    
    tempCtx.save();
    tempCtx.translate(-minX, -minY);
    
    // 1. Draw all images at their offset locations (with image adjustments applied)
    state.images.forEach(img => {
        tempCtx.save();
        const ox = img.offset ? img.offset.x : 0;
        const oy = img.offset ? img.offset.y : 0;
        tempCtx.translate(ox, oy);
        
        if (img.id === state.activeImageId && (state.filters.showBinary || state.filters.contrast !== 1.0 || state.filters.brightness !== 1.0) && filteredCanvas) {
            tempCtx.drawImage(filteredCanvas, 0, 0);
        } else if (img.imageEl) {
            tempCtx.drawImage(img.imageEl, 0, 0);
        }
        tempCtx.restore();
    });
    
    // 2. Draw overlays if chosen
    if (includeOverlays) {
        state.images.forEach(img => {
            if (img.origin) {
                const offset = img.offset || { x: 0, y: 0 };
                drawOriginMarkerOnCtx(tempCtx, 1.0, img.origin, offset);
            }
            drawFlakesForImage(img, tempCtx, 1.0, true);
        });
    }
    
    tempCtx.restore();
    
    try {
        const dataUrl = tempCanvas.toDataURL('image/jpeg', 0.90);
        const link = document.createElement('a');
        link.setAttribute('href', dataUrl);
        link.setAttribute('download', `FlakeLocator_Snip_Export.jpg`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast("Cropped image exported successfully!", "success");
    } catch (e) {
        console.error("Snip export failed:", e);
        showToast("Failed to export snip: Canvas security restriction.", "error");
    }
}

// ----------------------------------------------------
// Image Crop Tool
// ----------------------------------------------------

function drawCropPreview(currentPix) {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    const iw = imgObj && imgObj.imageEl ? imgObj.imageEl.naturalWidth  : 9999;
    const ih = imgObj && imgObj.imageEl ? imgObj.imageEl.naturalHeight : 9999;

    const start = state.drawingPoints[0];
    const x = Math.min(start.x, currentPix.x);
    const y = Math.min(start.y, currentPix.y);
    const w = Math.abs(currentPix.x - start.x);
    const h = Math.abs(currentPix.y - start.y);

    ctx.save();
    ctx.setTransform(state.zoom, 0, 0, state.zoom, state.pan.x, state.pan.y);

    // Dim area outside the crop selection
    ctx.fillStyle = 'rgba(0,0,0,0.52)';
    ctx.fillRect(0, 0, iw, y);
    ctx.fillRect(0, y + h, iw, ih - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, iw - x - w, h);

    // Marching-ants border
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 1.5 / state.zoom;
    ctx.setLineDash([6 / state.zoom, 3 / state.zoom]);
    ctx.strokeRect(x, y, w, h);

    // Corner anchors
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    const cs = 5 / state.zoom;
    [[x, y],[x+w, y],[x, y+h],[x+w, y+h]].forEach(([cx, cy]) => {
        ctx.fillRect(cx - cs/2, cy - cs/2, cs, cs);
    });

    // Dimension label
    const sr = (imgObj && imgObj.scaleRatio) ? imgObj.scaleRatio : state.scaleRatio;
    const wum = (w / sr).toFixed(1);
    const hum = (h / sr).toFixed(1);
    const label = `${w} × ${h} px  (${wum} × ${hum} µm)`;
    const fs = Math.max(10, 13 / state.zoom);
    ctx.font = `500 ${fs}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    const ly = y > 22 / state.zoom ? y - 7 / state.zoom : y + h + 16 / state.zoom;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 3 / state.zoom;
    ctx.strokeText(label, x + w / 2, ly);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + w / 2, ly);

    ctx.restore();
}

function applyCropToActiveImage(cx, cy, cw, ch) {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj || !imgObj.imageEl) {
        showToast("No active image to crop", "error");
        return;
    }

    // Clamp to image bounds
    const iw = imgObj.imageEl.naturalWidth;
    const ih = imgObj.imageEl.naturalHeight;
    cx = Math.max(0, cx); cy = Math.max(0, cy);
    cw = Math.min(cw, iw - cx); ch = Math.min(ch, ih - cy);

    if (cw < 4 || ch < 4) { showToast("Crop region outside image bounds", "warning"); return; }

    if (!confirm(`Crop to ${cw}×${ch} px?\nFlake coordinates will be adjusted. Cannot be undone.`)) {
        redraw(); return;
    }

    pushToUndoStack();

    // Render cropped region to a temporary canvas
    const tmp = document.createElement('canvas');
    tmp.width  = cw;
    tmp.height = ch;
    tmp.getContext('2d').drawImage(imgObj.imageEl, cx, cy, cw, ch, 0, 0, cw, ch);
    const newDataUrl = tmp.toDataURL('image/png');

    // Adjust flake pixel coords — flakes live in imgObj.flakes
    imgObj.flakes.forEach(f => {
        const shift = p => ({ x: p.x - cx, y: p.y - cy });
        if (f.points)      f.points      = f.points.map(shift);
        if (f.orientedBox) f.orientedBox = f.orientedBox.map(shift);
        if (f.boundingBox) {
            f.boundingBox = {
                minX: f.boundingBox.minX - cx, maxX: f.boundingBox.maxX - cx,
                minY: f.boundingBox.minY - cy, maxY: f.boundingBox.maxY - cy,
            };
        }
        if (f.centroid) f.centroid = { x: f.centroid.x - cx, y: f.centroid.y - cy };
        // Recompute µm position from shifted centroid
        const sr  = imgObj.scaleRatio || state.scaleRatio;
        const ox  = imgObj.origin ? imgObj.origin.x : 0;
        const oy  = imgObj.origin ? imgObj.origin.y : 0;
        const pcx = f.centroid ? f.centroid.x : 0;
        const pcy = f.centroid ? f.centroid.y : 0;
        f.x_um = (pcx - ox) / sr;
        f.y_um = imgObj.yAxisInverted ? -(pcy - oy) / sr : (pcy - oy) / sr;
    });

    // Adjust origin
    if (imgObj.origin) {
        imgObj.origin = { x: (imgObj.origin.x || 0) - cx, y: (imgObj.origin.y || 0) - cy };
        state.origin  = { ...imgObj.origin };
    }

    // Replace image data; clear imageEl so preloadAllImages reloads from new dataUrl
    imgObj.dataUrl  = newDataUrl;
    imgObj.imageEl  = null;

    loadImage(imgObj.id);
    showToast(`Cropped to ${cw}×${ch} px`, 'success');
}

// ----------------------------------------------------
// Custom Canvas Context Menu
// ----------------------------------------------------

function showCustomContextMenu(e) {
    e.preventDefault();
    
    // Remove any existing context menus
    dismissContextMenu();
    
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const pix = screenToPixel(screenX, screenY);
    
    const menu = document.createElement('div');
    menu.id = 'custom-context-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    // Bug fix #2: --background-card and --text-light are not defined in style.css.
    // Use the correct variable names from :root.
    menu.style.backgroundColor = 'var(--bg-panel-solid)';
    menu.style.border = '1px solid var(--border-color)';
    menu.style.borderRadius = '6px';
    menu.style.padding = '0.5rem 0';
    menu.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -2px rgba(0, 0, 0, 0.5)';
    menu.style.zIndex = '9999';
    menu.style.minWidth = '185px';
    menu.style.fontFamily = 'var(--font-sans)';

    const createItem = (label, icon, onClick, disabled = false) => {
        const item = document.createElement('div');
        item.style.padding = '0.5rem 1rem';
        item.style.cursor = disabled ? 'not-allowed' : 'pointer';
        item.style.color = disabled ? 'var(--text-muted)' : 'var(--text-primary)';
        item.style.fontSize = '0.8rem';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.gap = '0.5rem';
        item.style.transition = 'background-color 0.2s';

        item.innerHTML = `<span>${icon}</span> <span>${label}</span>`;

        if (!disabled) {
            item.addEventListener('mouseenter', () => {
                item.style.backgroundColor = 'rgba(6, 182, 212, 0.15)';
                item.style.color = 'var(--secondary-light)';
            });
            item.addEventListener('mouseleave', () => {
                item.style.backgroundColor = 'transparent';
                item.style.color = 'var(--text-primary)';
            });
            item.addEventListener('click', () => {
                onClick();
                dismissContextMenu();
            });
        }
        return item;
    };
    
    // Add "Load Substrate Images"
    menu.appendChild(createItem('Load Substrate Images', '📁', () => {
        document.getElementById('image-upload').click();
    }));
    
    // Add "Set Origin Here"
    menu.appendChild(createItem('Set Origin Here', '📍', () => {
        state.origin = { ...pix };
        document.getElementById('input-origin-x').value = pix.x;
        document.getElementById('input-origin-y').value = pix.y;
        updateActiveImageConfig();
        recalculateAllFlakes();
        showToast(`Coordinate Origin moved to (${pix.x}, ${pix.y})px`, 'info');
        redraw();
    }, !loadedImageEl));
    
    // Add "Auto-Detect Scale Bar"
    menu.appendChild(createItem('Auto-Detect Scale Bar', '🔍', () => {
        runAutoScaleBarCalibration();
    }, !loadedImageEl));
    
    // Add spacer line
    const hr = document.createElement('hr');
    hr.style.border = 'none';
    hr.style.borderTop = '1px solid var(--border-color)';
    hr.style.margin = '0.25rem 0';
    menu.appendChild(hr);
    
    // Add "Delete Hovered Flake"
    if (state.hoveredFlakeId) {
        const hoveredId = state.hoveredFlakeId;
        const imgObj = state.images.find(img => img.id === state.activeImageId);
        const flakeName = imgObj ? imgObj.flakes.find(f => f.id === hoveredId)?.name || 'Flake' : 'Flake';
        
        menu.appendChild(createItem(`Delete ${flakeName}`, '❌', () => {
            deleteFlake(hoveredId);
        }));
    } else {
        menu.appendChild(createItem('Delete Flake', '❌', () => {}, true));
    }
    
    // Add "Fit Viewport"
    menu.appendChild(createItem('Fit Viewport', '📐', () => {
        resetViewport();
        redraw();
    }, !loadedImageEl));
    
    // Add "Clear Ignore Areas" if any are defined
    if (state.ignoreAreas && state.ignoreAreas.length > 0) {
        menu.appendChild(createItem('Clear Ignore Areas', '🧹', () => {
            state.ignoreAreas = [];
            showToast("Custom Ignore Areas cleared", "info");
            redraw();
        }));
    }
    
    document.body.appendChild(menu);

    // Bug fix #12: flip anchor if menu overflows right or bottom viewport edge.
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) {
        menu.style.left = `${e.clientX - menuRect.width}px`;
    }
    if (menuRect.bottom > window.innerHeight) {
        menu.style.top = `${e.clientY - menuRect.height}px`;
    }

    // Global click listener to dismiss context menu
    setTimeout(() => {
        document.addEventListener('click', dismissContextMenu);
    }, 10);
}

function dismissContextMenu() {
    const existing = document.getElementById('custom-context-menu');
    if (existing) {
        existing.remove();
    }
    document.removeEventListener('click', dismissContextMenu);
}

// ----------------------------------------------------
// Custom Ignore Areas Helpers
// ----------------------------------------------------

function drawIgnoreAreas() {
    const activeImg = state.images.find(img => img.id === state.activeImageId);
    if (!activeImg || !state.ignoreAreas || state.ignoreAreas.length === 0) return;
    
    const offset = activeImg.offset || { x: 0, y: 0 };
    
    ctx.save();
    ctx.translate(offset.x, offset.y);
    
    state.ignoreAreas.forEach((area, idx) => {
        const isSelected = (idx === state.selectedIgnoreAreaIndex);
        const isHovered = (idx === state.hoveredIgnoreAreaIndex);
        
        ctx.strokeStyle = isSelected ? 'rgba(239, 68, 68, 0.95)' : (isHovered ? 'rgba(239, 68, 68, 0.8)' : 'rgba(239, 68, 68, 0.6)');
        ctx.fillStyle = isSelected ? 'rgba(239, 68, 68, 0.12)' : (isHovered ? 'rgba(239, 68, 68, 0.1)' : 'rgba(239, 68, 68, 0.08)');
        ctx.lineWidth = (isSelected ? 2.5 : (isHovered ? 2.0 : 1.5)) / state.zoom;
        
        if (!isSelected) {
            ctx.setLineDash([4 / state.zoom, 4 / state.zoom]);
        } else {
            ctx.setLineDash([]);
        }
        
        ctx.beginPath();
        ctx.rect(area.minX, area.minY, area.maxX - area.minX, area.maxY - area.minY);
        ctx.stroke();
        ctx.fill();
        ctx.setLineDash([]);
        
        ctx.fillStyle = 'rgba(239, 68, 68, 0.95)';
        ctx.font = `${Math.max(8, 10 / state.zoom)}px Fira Code`;
        ctx.fillText(`IGNORE #${idx+1}`, area.minX + 4 / state.zoom, area.minY + 12 / state.zoom);
        
        // Draw corner handles if selected
        if (isSelected) {
            const handleSize = 6 / state.zoom;
            ctx.fillStyle = '#ef4444';
            
            // Corners
            ctx.fillRect(area.minX - handleSize/2, area.minY - handleSize/2, handleSize, handleSize);
            ctx.fillRect(area.maxX - handleSize/2, area.minY - handleSize/2, handleSize, handleSize);
            ctx.fillRect(area.maxX - handleSize/2, area.maxY - handleSize/2, handleSize, handleSize);
            ctx.fillRect(area.minX - handleSize/2, area.maxY - handleSize/2, handleSize, handleSize);
            
            // Draw close text button '×' near top-right corner
            ctx.fillStyle = '#ef4444';
            ctx.font = `bold ${Math.max(10, 14 / state.zoom)}px Inter`;
            ctx.fillText('×', area.maxX - 12 / state.zoom, area.minY + 14 / state.zoom);
        }
    });
    
    ctx.restore();
}

function drawTemporaryIgnoreBox(currentPix) {
    const activeImg = state.images.find(img => img.id === state.activeImageId);
    const offset = activeImg ? (activeImg.offset || { x: 0, y: 0 }) : { x: 0, y: 0 };
    
    ctx.save();
    ctx.setTransform(state.zoom, 0, 0, state.zoom, state.pan.x, state.pan.y);
    ctx.translate(offset.x, offset.y);
    
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.9)';
    ctx.lineWidth = 2 / state.zoom;
    ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
    ctx.setLineDash([5 / state.zoom, 5 / state.zoom]);
    
    const start = state.drawingPoints[0];
    ctx.beginPath();
    ctx.rect(start.x, start.y, currentPix.x - start.x, currentPix.y - start.y);
    ctx.stroke();
    ctx.fill();
    
    ctx.restore();
}

// ----------------------------------------------------
// Undo / Redo Memento System
// ----------------------------------------------------

const historyState = {
    undoStack: [],
    redoStack: []
};

function serializeHistoryState() {
    return {
        images: state.images.map(img => ({
            id: img.id,
            name: img.name,
            dataUrl: img.dataUrl,
            width: img.width,
            height: img.height,
            scaleRatio: img.scaleRatio,
            scaleDistance: img.scaleDistance,
            origin: { ...img.origin },
            yAxisInverted: img.yAxisInverted,
            offset: { ...img.offset },
            flakes: img.flakes.map(f => ({
                id: f.id,
                name: f.name,
                color: f.color,
                type: f.type,
                points: f.points ? f.points.map(p => ({ ...p })) : [],
                centroid: { ...f.centroid },
                boundingBox: { ...f.boundingBox },
                orientedBox: f.orientedBox ? f.orientedBox.map(p => ({ ...p })) : [],
                length: f.length,
                width: f.width,
                area: f.area,
                orientation: f.orientation,
                x_um: f.x_um,
                y_um: f.y_um,
                customTag: f.customTag
            }))
        })),
        ignoreAreas: state.ignoreAreas.map(area => ({ ...area })),
        activeImageId: state.activeImageId
    };
}

function pushToUndoStack() {
    const snap = serializeHistoryState();
    if (historyState.undoStack.length >= 50) {
        historyState.undoStack.shift();
    }
    historyState.undoStack.push(snap);
    historyState.redoStack = []; // Clear redo stack on new action
    updateUndoRedoButtons();
}

function undo() {
    if (historyState.undoStack.length === 0) return;
    
    const currentSnap = serializeHistoryState();
    historyState.redoStack.push(currentSnap);
    
    const previousSnap = historyState.undoStack.pop();
    restoreHistoryState(previousSnap);
    
    showToast("Undo action", "info");
    updateUndoRedoButtons();
}

function redo() {
    if (historyState.redoStack.length === 0) return;
    
    const currentSnap = serializeHistoryState();
    historyState.undoStack.push(currentSnap);
    
    const nextSnap = historyState.redoStack.pop();
    restoreHistoryState(nextSnap);
    
    showToast("Redo action", "info");
    updateUndoRedoButtons();
}

function restoreHistoryState(snap) {
    snap.images.forEach(snapImg => {
        const existingImg = state.images.find(img => img.id === snapImg.id);
        if (existingImg) {
            snapImg.imageEl = existingImg.imageEl;
        }
    });
    
    state.images = snap.images;
    state.ignoreAreas = snap.ignoreAreas;
    
    // If active image changed, reload it
    if (state.activeImageId !== snap.activeImageId) {
        if (snap.activeImageId) {
            loadImage(snap.activeImageId);
        } else {
            state.activeImageId = null;
            loadedImageEl = null;
        }
    } else {
        const imgObj = state.images.find(img => img.id === state.activeImageId);
        if (imgObj) {
            state.scaleRatio = imgObj.scaleRatio;
            state.scaleDistance = imgObj.scaleDistance;
            state.origin = { ...imgObj.origin };
            state.yAxisInverted = imgObj.yAxisInverted;
            
            document.getElementById('input-scale').value = state.scaleRatio.toFixed(3);
            document.getElementById('input-origin-x').value = state.origin.x;
            document.getElementById('input-origin-y').value = state.origin.y;
        }
        
        renderSubstrateList();
        renderFlakes();
        redraw();
    }
}

function updateUndoRedoButtons() {
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (!undoBtn || !redoBtn) return;
    
    const undoDisabled = historyState.undoStack.length === 0;
    const redoDisabled = historyState.redoStack.length === 0;
    
    undoBtn.disabled = undoDisabled;
    redoBtn.disabled = redoDisabled;
    
    if (undoDisabled) {
        undoBtn.style.opacity = '0.4';
        undoBtn.style.cursor = 'not-allowed';
    } else {
        undoBtn.style.opacity = '1';
        undoBtn.style.cursor = 'pointer';
    }
    
    if (redoDisabled) {
        redoBtn.style.opacity = '0.4';
        redoBtn.style.cursor = 'not-allowed';
    } else {
        redoBtn.style.opacity = '1';
        redoBtn.style.cursor = 'pointer';
    }
}

// ----------------------------------------------------
// Keyboard Event Listeners for Undo / Redo & Ignore Areas
// ----------------------------------------------------
document.addEventListener('keydown', (e) => {
    // Undo: Ctrl+Z or Cmd+Z
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
    }
    // Redo: Ctrl+Y or Cmd+Y or Ctrl+Shift+Z or Cmd+Shift+Z
    if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')
    ) {
        e.preventDefault();
        redo();
    }
    // Delete selected ignore area with Delete or Backspace
    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
            if (state.tool === 'ignore' && state.selectedIgnoreAreaIndex !== null) {
                pushToUndoStack();
                state.ignoreAreas.splice(state.selectedIgnoreAreaIndex, 1);
                state.selectedIgnoreAreaIndex = null;
                showToast("Ignore Area removed", "info");
                redraw();
            }
        }
    }
});

// Global exposure for event callbacks
window.deleteFlake = deleteFlake;
window.updateFlakeTag = updateFlakeTag;
window.updateFlakeName = updateFlakeName;
window.handleTagSelectChange = handleTagSelectChange;
window.updateFlakeNote = updateFlakeNote;
window.closeReportModal = closeReportModal;
window.exportExcel = exportExcel;

// ============================================================
// DARK / LIGHT THEME TOGGLE
// ============================================================
let _currentTheme = 'light';

// ============================================================
// SIDEBAR COLLAPSE
// ============================================================
function toggleSidebar(side) {
    const workspace = document.querySelector('.app-workspace');
    if (!workspace) return;
    if (side === 'left') {
        workspace.classList.toggle('hide-left');
    } else {
        workspace.classList.toggle('hide-right');
    }
    // Force canvas resize once the grid transition finishes (250ms + small buffer)
    const _forceResize = () => {
        if (!canvas || !canvas.parentElement) return;
        const w = canvas.parentElement.clientWidth;
        const h = canvas.parentElement.clientHeight;
        if (w > 0 && h > 0) {
            canvas.width = w;
            canvas.height = h;
            redraw();
        }
    };
    setTimeout(_forceResize, 260);
}
window.toggleSidebar = toggleSidebar;

function toggleTheme() {
    _currentTheme = _currentTheme === 'dark' ? 'light' : 'dark';
    document.body.setAttribute('data-theme', _currentTheme);
    const btn = document.getElementById('btn-theme-toggle');
    if (btn) btn.textContent = _currentTheme === 'dark' ? '☀️' : '🌙';
    showToast(`Switched to ${_currentTheme} theme`, 'info');
}
window.toggleTheme = toggleTheme;

// ============================================================
// KEYBOARD SHORTCUTS PANEL
// ============================================================
function showKeyboardShortcuts() {
    const modal = document.getElementById('shortcuts-modal');
    if (modal) modal.classList.add('active');
}
window.showKeyboardShortcuts = showKeyboardShortcuts;

// ============================================================
// ============================================================
// LIVE STATS MINI-PANEL  (sidebar, always visible)
// ============================================================
function updateLiveStats() {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    const el = id => document.getElementById(id);
    if (!imgObj || imgObj.flakes.length === 0) {
        if (el('live-stat-count'))    el('live-stat-count').textContent    = '0';
        if (el('live-stat-area'))     el('live-stat-area').textContent     = '—';
        if (el('live-stat-coverage')) el('live-stat-coverage').textContent = '—';
        if (el('live-stat-layers'))   el('live-stat-layers').textContent   = '—';
        return;
    }
    const flakes = imgObj.flakes;
    const n = flakes.length;
    const avgArea = flakes.reduce((s, f) => s + (f.area || 0), 0) / n;
    const sr = imgObj.scaleRatio || 1;
    const imgAreaUm = ((imgObj.width || 1) * (imgObj.height || 1)) / (sr * sr);
    const totalFA = flakes.reduce((s, f) => s + (f.area || 0), 0);
    const cov = imgAreaUm > 0 ? (totalFA / imgAreaUm * 100) : 0;
    const layerNum = { 'Monolayer': 1, 'Bilayer': 2, 'Trilayer': 3, 'Few-Layer': 4, 'Thick Flake': 5 };
    const lf = flakes.filter(f => layerNum[f.customTag]);
    const avgL = lf.length > 0 ? (lf.reduce((s, f) => s + layerNum[f.customTag], 0) / lf.length).toFixed(1) : '—';
    if (el('live-stat-count'))    el('live-stat-count').textContent    = n;
    if (el('live-stat-area'))     el('live-stat-area').textContent     = avgArea.toFixed(1);
    if (el('live-stat-coverage')) el('live-stat-coverage').textContent = cov.toFixed(1) + '%';
    if (el('live-stat-layers'))   el('live-stat-layers').textContent   = avgL;
}

// ============================================================
// STATISTICAL DASHBOARD  (tabbed modal)
// ============================================================
function showStatsDashboard() {
    const allFlakes = [];
    state.images.forEach(img => img.flakes.forEach(f => allFlakes.push({ ...f, _imageName: img.name })));

    if (allFlakes.length === 0) {
        showToast('No flakes detected yet — run Auto-Detect or draw annotations first.', 'warning');
        return;
    }

    const modal = document.getElementById('stats-modal');
    if (!modal) return;
    modal.classList.add('active');

    const body = document.getElementById('stats-modal-body');
    body.innerHTML = '';

    // ---- Aggregate data ----
    const areas        = allFlakes.map(f => f.area   || 0);
    const lengths      = allFlakes.map(f => f.length || 0);
    const widths       = allFlakes.map(f => f.width  || 0);
    const aspects      = allFlakes.map(f => f.length / Math.max(f.width, 0.001));
    const orientations = allFlakes.map(f => f.orientation || 0);
    const circularities = allFlakes.map(f => {
        // Use stored perimeter if available; otherwise approximate from OBB (2*(L+W))
        // which is more realistic than the equivalent-circle estimate.
        const perim = f.perimeter
            || (2 * (Math.max(f.length || 0.01, 0.01) + Math.max(f.width || 0.01, 0.01)));
        const C = (4 * Math.PI * (f.area || 0)) / (perim * perim + 1e-9);
        return Math.max(0, Math.min(1, C));
    });

    const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const avgA  = mean(areas);
    const avgL  = mean(lengths);
    const avgAR = mean(aspects);

    const totalImgArea = state.images.reduce((s, img) => {
        const sr = img.scaleRatio || 1;
        return s + (img.width * img.height) / (sr * sr);
    }, 0);
    const totalFlakeArea = areas.reduce((a, b) => a + b, 0);
    const coveragePct = totalImgArea > 0 ? (totalFlakeArea / totalImgArea * 100) : 0;

    const tagCounts = {}, tagColors = {};
    allFlakes.forEach(f => {
        tagCounts[f.customTag] = (tagCounts[f.customTag] || 0) + 1;
        tagColors[f.customTag] = f.color || '#6b7280';
    });

    // ---- Internal helper: setup canvas DPR then call draw fn ----
    // Uses getBoundingClientRect for accurate width after layout; falls back to
    // parentElement.clientWidth if the element hasn't been painted yet.
    function setupC(cv, h, fn) {
        const rect = cv.getBoundingClientRect();
        let w = Math.floor(rect.width);
        if (w < 20 && cv.parentElement) {
            const pr = cv.parentElement.getBoundingClientRect();
            w = Math.floor(pr.width) - 24;
        }
        if (w < 20) w = 280; // absolute fallback
        cv.width  = w * devicePixelRatio;
        cv.height = h * devicePixelRatio;
        cv.style.width  = w + 'px';
        cv.style.height = h + 'px';
        const ctx = cv.getContext('2d');
        ctx.scale(devicePixelRatio, devicePixelRatio);
        fn(ctx, w, h);
    }

    // ---- Lazy-draw registry: charts in hidden tab panels must wait until visible ----
    const _lazyDrawQ = new Map(); // tabIndex → [{cv, h, fn}]
    function lazyDraw(tabIdx, cv, h, fn) {
        if (!_lazyDrawQ.has(tabIdx)) _lazyDrawQ.set(tabIdx, []);
        _lazyDrawQ.get(tabIdx).push({ cv, h, fn });
    }
    function flushTab(tabIdx) {
        const q = _lazyDrawQ.get(tabIdx);
        if (!q) return;
        _lazyDrawQ.delete(tabIdx);
        setTimeout(() => q.forEach(({ cv, h, fn }) => setupC(cv, h, fn)), 30);
    }

    // ---- Chart card factory ----
    function makeCard(title, parent, h = 180) {
        const card = document.createElement('div');
        card.className = 'chart-card';
        card.innerHTML = `<div class="chart-card-title">${title}</div>`;
        const cv = document.createElement('canvas');
        cv.style.cssText = `width:100%; height:${h}px; display:block;`;
        card.appendChild(cv);
        const expBtn = document.createElement('button');
        expBtn.className = 'chart-export-btn'; expBtn.title = 'Export PNG'; expBtn.textContent = '⬇ PNG';
        expBtn.onclick = () => {
            const a = document.createElement('a');
            a.href = cv.toDataURL('image/png');
            a.download = title.replace(/[^a-z0-9]/gi, '_') + '.png';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
        };
        card.appendChild(expBtn);
        (parent || body).appendChild(card);
        return cv;
    }

    // ---- Summary chips ----
    const metricsRow = document.createElement('div');
    metricsRow.style.cssText = 'display:grid; grid-template-columns:repeat(5,1fr); gap:0.5rem; margin-bottom:0.75rem;';
    [
        { label: 'Total Flakes', val: allFlakes.length, unit: '',      color: 'var(--secondary)' },
        { label: 'Avg Area',     val: avgA.toFixed(1),  unit: ' µm<sup>2</sup>',  color: 'var(--primary)' },
        { label: 'Avg Length',   val: avgL.toFixed(1),  unit: ' µm',   color: '#a855f7' },
        { label: 'Avg Aspect',   val: avgAR.toFixed(2), unit: '',       color: 'var(--warning)' },
        { label: 'Coverage',     val: coveragePct.toFixed(2), unit: '%', color: '#ef4444' },
    ].forEach(({ label, val, unit, color }) => {
        const chip = document.createElement('div');
        chip.className = 'stats-metric';
        chip.innerHTML = `<div class="stats-metric-val" style="color:${color};">${val}<span style="font-size:0.7rem;color:var(--text-muted);">${unit}</span></div><div class="stats-metric-label">${label}</div>`;
        metricsRow.appendChild(chip);
    });
    body.appendChild(metricsRow);

    // ---- Export bar ----
    const exportBar = document.createElement('div');
    exportBar.style.cssText = 'display:flex; gap:0.5rem; justify-content:flex-end; margin-bottom:0.65rem;';
    const csvBtn = document.createElement('button');
    csvBtn.className = 'stats-export-btn'; csvBtn.textContent = '⬇ Stats CSV';
    csvBtn.onclick = () => _exportStatsCSV(allFlakes);
    exportBar.appendChild(csvBtn);
    body.appendChild(exportBar);

    // ---- Tab bar ----
    const tabBar = document.createElement('div');
    tabBar.className = 'stats-tab-bar';
    const tabNames = ['Overview', 'Distributions', 'Spatial', 'Correlations'];
    const panels = tabNames.map((name, i) => {
        const btn = document.createElement('button');
        btn.className = 'stats-tab-btn' + (i === 0 ? ' active' : '');
        btn.textContent = name;
        btn.onclick = () => {
            tabBar.querySelectorAll('.stats-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            panels.forEach((p, j) => p.classList.toggle('active', j === i));
            // Flush any lazily-registered chart draws for this tab
            flushTab(i);
        };
        tabBar.appendChild(btn);
        const panel = document.createElement('div');
        panel.className = 'stats-tab-panel' + (i === 0 ? ' active' : '');
        return panel;
    });
    body.appendChild(tabBar);
    panels.forEach(p => body.appendChild(p));

    const grid2 = () => { const d = document.createElement('div'); d.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;'; return d; };

    // ======================================================
    // TAB 0 — OVERVIEW  (rendered immediately after 40ms for layout to settle)
    // ======================================================
    const ovGrid = grid2();
    panels[0].appendChild(ovGrid);

    const cv1 = makeCard('Layer Classification', ovGrid);
    lazyDraw(0, cv1, 180, (ctx, w, h) => _drawPieChart(ctx, w, h, tagCounts, tagColors));

    const cv2 = makeCard('Area Distribution (µm²)', ovGrid);  // card title — plain text node
    lazyDraw(0, cv2, 180, (ctx, w, h) => _drawHistogram(ctx, w, h, areas, '#10b981', 'µm²'));

    const cv3 = makeCard('Length vs Width (µm)', ovGrid);
    lazyDraw(0, cv3, 180, (ctx, w, h) => {
        cv3._pts = _drawGenericScatter(ctx, w, h, allFlakes, tagColors,
            f => f.length, f => f.width, 'Length (µm)', 'Width (µm)');
    });
    cv3.addEventListener('click', e => _scatterClickHandler(e, cv3, allFlakes));

    const cv4 = makeCard('Orientation Rose (°)', ovGrid);
    lazyDraw(0, cv4, 180, (ctx, w, h) => _drawOrientationRose(ctx, w, h, orientations));

    _appendLayerTable(panels[0], allFlakes, tagCounts, tagColors);

    // ======================================================
    // TAB 1 — DISTRIBUTIONS  (lazy: rendered when tab is clicked)
    // ======================================================
    const distGrid = grid2();
    panels[1].appendChild(distGrid);

    const cv5 = makeCard('Length & Width Overlay (µm)', distGrid);
    lazyDraw(1, cv5, 180, (ctx, w, h) => _drawOverlaidHistograms(ctx, w, h, lengths, widths));

    const cv6 = makeCard('Area Power Law — log-log fit', distGrid);
    lazyDraw(1, cv6, 180, (ctx, w, h) => _drawPowerLawPlot(ctx, w, h, areas));

    const cv7 = makeCard('Optical Contrast CDF (%)', distGrid);
    lazyDraw(1, cv7, 180, (ctx, w, h) => _drawContrastCDF(ctx, w, h, allFlakes));

    const cv8 = makeCard('Circularity  4πA/P²', distGrid);
    lazyDraw(1, cv8, 180, (ctx, w, h) => _drawHistogram(ctx, w, h, circularities, '#f59e0b', ''));

    _appendBrushFilter(panels[1]);

    // ======================================================
    // TAB 2 — SPATIAL  (lazy)
    // ======================================================
    const spatGrid = grid2();
    panels[2].appendChild(spatGrid);

    const cv9 = makeCard('Spatial Density Heatmap', spatGrid, 200);
    lazyDraw(2, cv9, 200, (ctx, w, h) => _drawDensityHeatmap(ctx, w, h, allFlakes));

    const cv10 = makeCard('Nearest-Neighbour Distance (µm)', spatGrid);
    const _nndVals = _computeNND(allFlakes); // compute once, reuse
    lazyDraw(2, cv10, 180, (ctx, w, h) => _drawHistogram(ctx, w, h, _nndVals, '#8b5cf6', 'µm'));

    const cv11 = makeCard('Pair Correlation  g(r)', spatGrid);
    lazyDraw(2, cv11, 180, (ctx, w, h) => _drawPairCorrelation(ctx, w, h, allFlakes));

    const cv12 = makeCard('Per-Image Coverage (%)', spatGrid);
    lazyDraw(2, cv12, 180, (ctx, w, h) => _drawCoverageBar(ctx, w, h));

    // ======================================================
    // TAB 3 — CORRELATIONS  (lazy)
    // ======================================================
    const corrGrid = grid2();
    panels[3].appendChild(corrGrid);

    const cv13 = makeCard('Contrast vs Area — scatter', corrGrid);
    const cfFlakes = allFlakes.filter(f => f.relContrast != null);
    lazyDraw(3, cv13, 180, (ctx, w, h) => {
        cv13._pts = _drawGenericScatter(ctx, w, h, cfFlakes, tagColors,
            f => f.area, f => f.relContrast * 100, 'Area (µm²)', 'Contrast (%)');
    });
    cv13.addEventListener('click', e => _scatterClickHandler(e, cv13, cfFlakes));

    const cv14 = makeCard('Pearson Correlation Matrix', corrGrid, 220);
    lazyDraw(3, cv14, 220, (ctx, w, h) => _drawCorrelationMatrix(ctx, w, h, allFlakes));

    const cv15 = makeCard('Aspect Ratio Distribution', corrGrid);
    lazyDraw(3, cv15, 180, (ctx, w, h) => _drawHistogram(ctx, w, h, aspects, '#ec4899', ''));

    const cv16 = makeCard('Cross-Image Flake Count', corrGrid);
    lazyDraw(3, cv16, 180, (ctx, w, h) => _drawCrossImageBar(ctx, w, h));

    // Flush tab 0 after 50ms so modal transition has completed and layout is stable
    flushTab(0);
}
window.showStatsDashboard = showStatsDashboard;

// ============================================================
// STATS HELPER — CSV EXPORT
// ============================================================
function _exportStatsCSV(allFlakes) {
    let csv = 'Name,Image,X_um,Y_um,Length_um,Width_um,AspectRatio,Area_um2,Orientation,Tag,RelContrast_pct,Notes\n';
    allFlakes.forEach(f => {
        csv += `"${f.name}","${f._imageName||''}",` +
            `${f.x_um?.toFixed(3)},${f.y_um?.toFixed(3)},` +
            `${f.length?.toFixed(3)},${f.width?.toFixed(3)},` +
            `${(f.length/Math.max(f.width,0.001)).toFixed(3)},${f.area?.toFixed(2)},` +
            `${f.orientation},"${f.customTag}",` +
            `${f.relContrast!=null?(f.relContrast*100).toFixed(2):''},"${(f.notes||'').replace(/"/g,'""')}"\n`;
    });
    const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
        download: 'FlakeLocator_Stats.csv',
        style: 'display:none'
    });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    showToast('Stats exported as CSV', 'success');
}

// ============================================================
// STATS HELPER — PER-LAYER TABLE
// ============================================================
function _appendLayerTable(parent, allFlakes, tagCounts, tagColors) {
    const section = document.createElement('div');
    section.style.cssText = 'margin-top:0.85rem;';
    section.innerHTML = '<div class="stats-section-header">Per-Layer Statistics</div>';
    const layerOrder = ['Monolayer','Bilayer','Trilayer','Few-Layer','Thick Flake','Residue'];
    const allTags = [...new Set([...layerOrder, ...Object.keys(tagCounts)])].filter(t => tagCounts[t] > 0);
    const tbl = document.createElement('table');
    tbl.className = 'stats-layer-table';
    tbl.innerHTML = `<thead><tr><th>Layer</th><th>Count</th><th>%</th>
        <th>Avg Area (µm<sup>2</sup>)</th><th>Avg Length (µm)</th><th>Avg AR</th><th>Avg Contrast (%)</th></tr></thead>`;
    const tbody = document.createElement('tbody');
    allTags.forEach(tag => {
        const g = allFlakes.filter(f => f.customTag === tag), n = g.length;
        const cg = g.filter(f => f.relContrast != null);
        const avgC = cg.length ? (cg.reduce((s,f) => s+f.relContrast,0)/cg.length*100).toFixed(1) : '—';
        const tr = document.createElement('tr');
        tr.innerHTML = `<td><span class="stats-color-dot" style="background:${tagColors[tag]||'#6b7280'};"></span>${tag}</td>
            <td>${n}</td><td>${(n/allFlakes.length*100).toFixed(1)}%</td>
            <td>${(g.reduce((s,f)=>s+f.area,0)/n).toFixed(1)}</td>
            <td>${(g.reduce((s,f)=>s+f.length,0)/n).toFixed(1)}</td>
            <td>${(g.reduce((s,f)=>s+(f.length/Math.max(f.width,0.001)),0)/n).toFixed(2)}</td>
            <td>${avgC}</td>`;
        tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    section.appendChild(tbl);
    parent.appendChild(section);
}

// ============================================================
// STATS HELPER — BRUSH / RANGE FILTER
// ============================================================
function _appendBrushFilter(parent) {
    const section = document.createElement('div');
    section.style.cssText = 'margin-top:0.75rem; padding:0.6rem; background:var(--bg-inset); border-radius:8px; border:1px solid var(--border-color);';
    const inp = (id, ph, v) => `<input type="number" id="${id}" placeholder="${ph}" value="${v}" style="width:100%;margin-top:0.2rem;font-size:0.7rem;padding:0.2rem 0.35rem;border-radius:5px;border:1px solid var(--border-color);background:var(--input-bg);color:var(--text-primary);">`;
    section.innerHTML = `<div class="stats-section-header" style="margin-bottom:0.4rem;">🔍 Range Filter → Flake List</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.5rem;font-size:0.7rem;color:var(--text-dim);">
            <div><label>Min Area (µm<sup>2</sup>)</label>${inp('brush-min-area','0','0')}</div>
            <div><label>Max Area (µm<sup>2</sup>)</label>${inp('brush-max-area','∞','')}</div>
            <div><label>Min Contrast (%)</label>${inp('brush-min-contrast','0','0')}</div>
        </div>
        <div style="display:flex;gap:0.5rem;margin-top:0.5rem;">
            <button class="stats-export-btn" onclick="applyStatsBrushFilter()" style="font-size:0.68rem;">Apply Filter</button>
            <button class="stats-export-btn" onclick="clearStatsBrushFilter()" style="font-size:0.68rem;background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.3);color:#f87171;">Clear</button>
        </div>`;
    parent.appendChild(section);
}
function applyStatsBrushFilter() {
    const v = id => parseFloat(document.getElementById(id)?.value);
    const minArea = v('brush-min-area') || 0;
    const maxArea = v('brush-max-area') > 0 ? v('brush-max-area') : Infinity;
    const minContrast = (v('brush-min-contrast') || 0) / 100;
    state.brushFilter = { minArea, maxArea, minContrast };
    renderFlakes();
    showToast(`Filter: area ${minArea}–${maxArea===Infinity?'∞':maxArea} µm², contrast ≥${(minContrast*100).toFixed(0)}%`, 'info');
}
function clearStatsBrushFilter() {
    state.brushFilter = null;
    renderFlakes();
    showToast('Range filter cleared', 'info');
}
window.applyStatsBrushFilter = applyStatsBrushFilter;
window.clearStatsBrushFilter = clearStatsBrushFilter;

// ============================================================
// CHART PRIMITIVES — shared theme helpers
// ============================================================
function _themeColors() {
    const isDark = document.body.getAttribute('data-theme') !== 'light';
    return {
        grid  : isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)',
        axis  : isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.20)',
        label : isDark ? '#9ca3af' : '#475569',
        bg    : isDark ? '#111827' : '#f8fafc',
    };
}

// ---- Histogram (supports optional forceMin / forceMax for fixed x-range) ----
function _drawHistogram(ctx, w, h, values, color, unit, forceMin, forceMax) {
    if (!values || values.length === 0) return;
    const PAD = { top: 12, right: 10, bottom: 28, left: 34 };
    const cw = w - PAD.left - PAD.right, ch = h - PAD.top - PAD.bottom;
    const { grid, axis, label } = _themeColors();

    const nBins = Math.max(5, Math.min(16, Math.round(Math.sqrt(values.length))));
    const minV  = forceMin !== undefined ? forceMin : Math.min(...values);
    const maxV  = (forceMax !== undefined ? forceMax : Math.max(...values)) + 1e-9;
    const bw    = (maxV - minV) / nBins;
    const bins  = Array(nBins).fill(0);
    values.forEach(v => { const i = Math.min(nBins-1, Math.floor((v-minV)/bw)); if (i>=0) bins[i]++; });
    const maxBin = Math.max(...bins, 1);

    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
        const y = PAD.top + ch - (i/4)*ch;
        ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left+cw, y); ctx.stroke();
        ctx.fillStyle = label; ctx.font = '9px Inter'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(Math.round(maxBin*i/4), PAD.left-3, y);
    }
    bins.forEach((count, i) => {
        const bh = (count/maxBin)*ch;
        const x  = PAD.left + i*(cw/nBins);
        ctx.fillStyle = color+'bb'; ctx.fillRect(x+1, PAD.top+ch-bh, cw/nBins-2, bh);
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.strokeRect(x+1, PAD.top+ch-bh, cw/nBins-2, bh);
    });
    // X-axis labels — use toFixed(2) only when values are small to avoid "0.0" everywhere
    const fmt = v => Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1);
    ctx.fillStyle = label; ctx.font = '9px Inter'; ctx.textBaseline = 'top';
    [0, Math.floor(nBins/2), nBins].forEach(i => {
        const txt = fmt(minV + i*bw) + (i===nBins && unit ? unit : '');
        // Keep left label inside canvas (avoid negative x for long strings)
        if (i === 0) {
            ctx.textAlign = 'left';
            ctx.fillText(txt, PAD.left, PAD.top+ch+4);
        } else if (i === nBins) {
            ctx.textAlign = 'right';
            ctx.fillText(txt, PAD.left+cw, PAD.top+ch+4);
        } else {
            ctx.textAlign = 'center';
            ctx.fillText(txt, PAD.left + i*(cw/nBins), PAD.top+ch+4);
        }
    });
    ctx.strokeStyle = axis; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.left, PAD.top); ctx.lineTo(PAD.left, PAD.top+ch); ctx.lineTo(PAD.left+cw, PAD.top+ch);
    ctx.stroke();
}

// ---- Orientation rose ----
function _drawOrientationRose(ctx, w, h, orientations) {
    const cx = w/2, cy = h/2, r = Math.min(cx, cy)-18;
    const { grid, label } = _themeColors();
    const nBins = 18, bins = Array(nBins).fill(0);
    orientations.forEach(deg => { const norm = ((deg%180)+180)%180; bins[Math.min(nBins-1,Math.floor(norm/10))]++; });
    const maxBin = Math.max(...bins, 1);
    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    [0.33,0.66,1.0].forEach(s => { ctx.beginPath(); ctx.arc(cx,cy,r*s,0,Math.PI*2); ctx.stroke(); });
    const spread = (10*Math.PI/180)/2;
    bins.forEach((count, i) => {
        if (!count) return;
        const angle = (i*10-90)*Math.PI/180, pr = (count/maxBin)*r;
        [angle, angle+Math.PI].forEach(a => {
            ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,pr,a-spread,a+spread); ctx.closePath();
            ctx.fillStyle = 'rgba(6,182,212,0.45)'; ctx.fill();
            ctx.strokeStyle = '#06b6d4'; ctx.lineWidth = 1; ctx.stroke();
        });
    });
    ctx.fillStyle = label; ctx.font = '9px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    [[-Math.PI/2,'0°'],[0,'90°']].forEach(([a,lbl]) =>
        ctx.fillText(lbl, cx+(r+13)*Math.cos(a), cy+(r+13)*Math.sin(a)));
}

// ---- Pie chart ----
function _drawPieChart(ctx, w, h, tagCounts, tagColors) {
    const { label } = _themeColors();
    const tags = Object.keys(tagCounts), total = Object.values(tagCounts).reduce((a,b)=>a+b,0);
    const cx = w*0.28, cy = h/2, r = Math.min(cy-8, 60);
    let angle = -Math.PI/2;
    tags.forEach(tag => {
        const slice = (tagCounts[tag]/total)*2*Math.PI;
        ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,r,angle,angle+slice); ctx.closePath();
        ctx.fillStyle = tagColors[tag]||'#6b7280'; ctx.fill();
        ctx.strokeStyle = '#0b0f19'; ctx.lineWidth = 2; ctx.stroke();
        angle += slice;
    });
    let ly = 12; ctx.font = '10px Inter'; ctx.textBaseline = 'middle';
    tags.forEach(tag => {
        const pct = (tagCounts[tag]/total*100).toFixed(1);
        ctx.fillStyle = tagColors[tag]||'#6b7280'; ctx.fillRect(w*0.58,ly,10,10);
        ctx.fillStyle = label;
        ctx.textAlign = 'left';
        ctx.fillText(`${tag} ×${tagCounts[tag]} (${pct}%)`, w*0.58+14, ly+5);
        ly += 22;
    });
}

// ---- Generic scatter — returns [{px,py,flake}] for click-through ----
function _drawGenericScatter(ctx, w, h, flakes, tagColors, xFn, yFn, xLabel, yLabel) {
    const PAD = { top: 12, right: 14, bottom: 28, left: 36 };
    const cw = w-PAD.left-PAD.right, ch = h-PAD.top-PAD.bottom;
    const { grid, axis, label } = _themeColors();

    const xs = flakes.map(xFn), ys = flakes.map(yFn);
    const maxX = Math.max(...xs, 1), maxY = Math.max(...ys, 1);
    const minX = Math.min(...xs, 0), minY = Math.min(...ys, 0);
    const ranX = maxX - minX || 1, ranY = maxY - minY || 1;

    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    [0.25,0.5,0.75,1.0].forEach(s => {
        ctx.beginPath(); ctx.moveTo(PAD.left+s*cw,PAD.top); ctx.lineTo(PAD.left+s*cw,PAD.top+ch); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(PAD.left,PAD.top+ch-s*ch); ctx.lineTo(PAD.left+cw,PAD.top+ch-s*ch); ctx.stroke();
    });

    const pts = [];
    flakes.forEach(f => {
        const px = PAD.left + ((xFn(f)-minX)/ranX)*cw;
        const py = PAD.top  + ch - ((yFn(f)-minY)/ranY)*ch;
        ctx.beginPath(); ctx.arc(px,py,2.8,0,Math.PI*2);
        ctx.fillStyle = (tagColors[f.customTag]||'#6b7280')+'cc'; ctx.fill();
        pts.push({ px, py, flake: f });
    });

    ctx.fillStyle = label; ctx.font = '9px Inter';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    if (xLabel) ctx.fillText(xLabel, PAD.left+cw/2, PAD.top+ch+5);
    if (yLabel) {
        ctx.save(); ctx.translate(PAD.left-28, PAD.top+ch/2);
        ctx.rotate(-Math.PI/2); ctx.textAlign='center';
        ctx.fillText(yLabel, 0, 0); ctx.restore();
    }
    ctx.textAlign='right'; ctx.textBaseline='middle';
    ctx.fillText(maxX.toFixed(1), PAD.left+cw, PAD.top+ch+4);
    ctx.fillText(maxY.toFixed(1), PAD.left-3, PAD.top);

    ctx.strokeStyle = axis; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.left,PAD.top); ctx.lineTo(PAD.left,PAD.top+ch); ctx.lineTo(PAD.left+cw,PAD.top+ch);
    ctx.stroke();
    return pts;
}

// ---- Click-through: find nearest scatter point → selectFlake ----
function _scatterClickHandler(e, cv, flakes) {
    const pts = cv._pts;
    if (!pts || !pts.length) return;
    const rect = cv.getBoundingClientRect();
    const scaleX = cv.clientWidth ? cv.clientWidth / cv.getBoundingClientRect().width : 1;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleX;
    let best = null, bestD = 14;
    pts.forEach(pt => {
        const d = Math.hypot(pt.px - mx, pt.py - my);
        if (d < bestD) { bestD = d; best = pt; }
    });
    if (best) {
        // Close the stats modal so the canvas is visible
        const modal = document.getElementById('stats-modal');
        if (modal) modal.classList.remove('active');
        selectFlake(best.flake.id);
        showToast(`Jumped to ${best.flake.name}`, 'info');
    }
}

// ---- Overlaid Length & Width histograms ----
function _drawOverlaidHistograms(ctx, w, h, arr1, arr2) {
    const { grid, axis, label } = _themeColors();
    const PAD = { top: 12, right: 10, bottom: 28, left: 34 };
    const cw = w-PAD.left-PAD.right, ch = h-PAD.top-PAD.bottom;
    const allVals = [...arr1, ...arr2];
    const nBins = Math.max(5, Math.min(14, Math.round(Math.sqrt(arr1.length))));
    const minV = Math.min(...allVals), maxV = Math.max(...allVals)+1e-9, bw = (maxV-minV)/nBins;
    const makeBins = arr => { const b=Array(nBins).fill(0); arr.forEach(v=>{b[Math.min(nBins-1,Math.floor((v-minV)/bw))]++;}); return b; };
    const b1 = makeBins(arr1), b2 = makeBins(arr2);
    const maxBin = Math.max(...b1,...b2,1);

    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    for (let i=1;i<=4;i++) {
        const y = PAD.top+ch-(i/4)*ch;
        ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(PAD.left+cw,y); ctx.stroke();
        ctx.fillStyle=label; ctx.font='9px Inter'; ctx.textAlign='right'; ctx.textBaseline='middle';
        ctx.fillText(Math.round(maxBin*i/4), PAD.left-3, y);
    }
    const drawB = (bins, color) => bins.forEach((count,i) => {
        const bh=(count/maxBin)*ch, x=PAD.left+i*(cw/nBins);
        ctx.fillStyle=color+'66'; ctx.fillRect(x+1,PAD.top+ch-bh,cw/nBins-2,bh);
        ctx.strokeStyle=color; ctx.lineWidth=1; ctx.strokeRect(x+1,PAD.top+ch-bh,cw/nBins-2,bh);
    });
    drawB(b1,'#06b6d4'); drawB(b2,'#f59e0b');

    // Legend
    ctx.fillStyle='#06b6d4'; ctx.fillRect(PAD.left,6,10,8);
    ctx.fillStyle=label; ctx.font='9px Inter'; ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.fillText('Length', PAD.left+14, 10);
    ctx.fillStyle='#f59e0b'; ctx.fillRect(PAD.left+60,6,10,8);
    ctx.fillStyle=label; ctx.fillText('Width', PAD.left+74, 10);

    ctx.fillStyle=label; ctx.font='9px Inter'; ctx.textBaseline='top';
    [0,Math.floor(nBins/2),nBins].forEach(i=>{
        ctx.textAlign=i===0?'left':i===nBins?'right':'center';
        ctx.fillText((minV+i*bw).toFixed(1), PAD.left+i*(cw/nBins), PAD.top+ch+4);
    });
    ctx.strokeStyle=axis; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(PAD.left,PAD.top); ctx.lineTo(PAD.left,PAD.top+ch); ctx.lineTo(PAD.left+cw,PAD.top+ch); ctx.stroke();
}

// ---- Power law log-log with MLE fit ----
function _drawPowerLawPlot(ctx, w, h, areas) {
    const { grid, axis, label } = _themeColors();
    const PAD = { top: 22, right: 10, bottom: 28, left: 36 };
    const cw = w-PAD.left-PAD.right, ch = h-PAD.top-PAD.bottom;

    const vals = areas.filter(a => a > 0);
    if (vals.length < 3) { ctx.fillStyle=label; ctx.font='11px Inter'; ctx.textAlign='center'; ctx.fillText('Need ≥3 flakes', w/2, h/2); return; }

    const logV = vals.map(v => Math.log10(v));
    const nBins = Math.max(5, Math.min(12, Math.round(Math.sqrt(vals.length))));
    const minL = Math.min(...logV), maxL = Math.max(...logV)+1e-9, bwL = (maxL-minL)/nBins;
    const bins = Array(nBins).fill(0);
    logV.forEach(v => { bins[Math.min(nBins-1, Math.floor((v-minL)/bwL))]++; });
    const maxBin = Math.max(...bins, 1);

    ctx.strokeStyle=grid; ctx.lineWidth=1;
    for (let i=1;i<=4;i++) {
        const y=PAD.top+ch-(i/4)*ch;
        ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(PAD.left+cw,y); ctx.stroke();
    }
    bins.forEach((count,i)=>{
        if(!count)return;
        const lc=Math.log10(Math.max(count,1));
        const lcMax=Math.log10(maxBin);
        const bh=(lc/lcMax)*ch, x=PAD.left+i*(cw/nBins);
        ctx.fillStyle='#10b98166'; ctx.fillRect(x+1,PAD.top+ch-bh,cw/nBins-2,bh);
        ctx.strokeStyle='#10b981'; ctx.lineWidth=1; ctx.strokeRect(x+1,PAD.top+ch-bh,cw/nBins-2,bh);
    });

    // MLE power law exponent: α = 1 + n/Σln(xi/xmin)
    const xmin = Math.min(...vals);
    const n = vals.length;
    const sumLn = vals.reduce((s,v)=>s+Math.log(v/xmin),0);
    const alpha = 1 + n / (sumLn + 1e-9);

    // Overlay power law line (theoretical log-log: y = C·x^(−α))
    ctx.strokeStyle='#f59e0b'; ctx.lineWidth=1.5; ctx.setLineDash([4,3]);
    ctx.beginPath();
    for (let i=0;i<=cw;i++) {
        const logX = minL + (i/cw)*(maxL-minL);
        const x_val = Math.pow(10, logX);
        const y_val = Math.pow(x_val/xmin, -(alpha-1)) * maxBin;
        const ly = Math.log10(Math.max(y_val,0.5))/Math.log10(maxBin)*ch;
        const px = PAD.left+i, py = PAD.top+ch - Math.min(ly, ch);
        if (i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
    }
    ctx.stroke(); ctx.setLineDash([]);

    // X-axis: show rounded exponents, never wider than the canvas
    ctx.fillStyle=label; ctx.font='9px Inter'; ctx.textBaseline='top';
    [0, Math.floor(nBins/2), nBins].forEach(i => {
        const exp = (minL + i*bwL).toFixed(1);
        const txt = i===0 ? exp : (i===nBins ? exp : exp); // plain exponent value
        if (i===0) { ctx.textAlign='left'; ctx.fillText(txt, PAD.left, PAD.top+ch+4); }
        else if (i===nBins) { ctx.textAlign='right'; ctx.fillText(txt, PAD.left+cw, PAD.top+ch+4); }
        else { ctx.textAlign='center'; ctx.fillText(txt, PAD.left+i*(cw/nBins), PAD.top+ch+4); }
    });
    // X-axis label
    ctx.textAlign='center'; ctx.fillText('log₁₀ Area (µm²)', PAD.left+cw/2, PAD.top+ch+14);

    ctx.strokeStyle=axis; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(PAD.left,PAD.top); ctx.lineTo(PAD.left,PAD.top+ch); ctx.lineTo(PAD.left+cw,PAD.top+ch); ctx.stroke();

    // Fit label
    ctx.fillStyle='#f59e0b'; ctx.font='bold 10px Inter'; ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.fillText(`α = ${alpha.toFixed(2)}  (MLE, n=${n})`, PAD.left+2, 4);
}

// ---- Optical contrast CDF with layer markers ----
function _drawContrastCDF(ctx, w, h, flakes) {
    const { grid, axis, label } = _themeColors();
    const PAD = { top: 12, right: 10, bottom: 28, left: 36 };
    const cw = w-PAD.left-PAD.right, ch = h-PAD.top-PAD.bottom;
    // Clamp relContrast to [0, 1] before converting to %: negative contrast
    // (flake brighter than substrate) and values > 1 are artefacts of the
    // Fresnel estimator on thick flakes; clamp them to keep the CDF readable.
    const vals = flakes
        .filter(f=>f.relContrast!=null)
        .map(f=>Math.max(0, Math.min(100, f.relContrast*100)))
        .sort((a,b)=>a-b);
    if (vals.length < 2) { ctx.fillStyle=label; ctx.font='11px Inter'; ctx.textAlign='center'; ctx.fillText('No contrast data', w/2, h/2); return; }
    const minC = vals[0], maxC = vals[vals.length-1]+1e-9, ranC = maxC-minC||1;

    ctx.strokeStyle=grid; ctx.lineWidth=1;
    [0.25,0.5,0.75,1.0].forEach(s=>{
        const y=PAD.top+ch-s*ch;
        ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(PAD.left+cw,y); ctx.stroke();
        ctx.fillStyle=label; ctx.font='9px Inter'; ctx.textAlign='right'; ctx.textBaseline='middle';
        ctx.fillText(`${(s*100).toFixed(0)}%`, PAD.left-3, y);
    });

    // CDF line
    ctx.strokeStyle='#06b6d4'; ctx.lineWidth=1.5; ctx.beginPath();
    vals.forEach((v,i)=>{
        const px=PAD.left+((v-minC)/ranC)*cw, py=PAD.top+ch-((i+1)/vals.length)*ch;
        if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
    }); ctx.stroke();

    // Layer markers (graphene-on-SiO2 typical values at 550nm)
    const markers = [['1L',2.3,'#22c55e'],['2L',4.5,'#3b82f6'],['3L',6.7,'#a855f7']];
    markers.forEach(([lbl,val,col])=>{
        if(val<minC||val>maxC)return;
        const px=PAD.left+((val-minC)/ranC)*cw;
        ctx.strokeStyle=col; ctx.lineWidth=1; ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.moveTo(px,PAD.top); ctx.lineTo(px,PAD.top+ch); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle=col; ctx.font='8px Inter'; ctx.textAlign='center'; ctx.textBaseline='top';
        ctx.fillText(lbl, px, PAD.top+2);
    });

    ctx.fillStyle=label; ctx.font='9px Inter'; ctx.textBaseline='top';
    [0,0.5,1.0].forEach(s=>{
        ctx.textAlign=s===0?'left':s===1?'right':'center';
        ctx.fillText((minC+s*ranC).toFixed(1)+'%', PAD.left+s*cw, PAD.top+ch+4);
    });
    ctx.strokeStyle=axis; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(PAD.left,PAD.top); ctx.lineTo(PAD.left,PAD.top+ch); ctx.lineTo(PAD.left+cw,PAD.top+ch); ctx.stroke();
}

// ---- 2D density heatmap ----
function _drawDensityHeatmap(ctx, w, h, flakes) {
    if (!flakes.length) return;
    const { label } = _themeColors();
    const PAD = { top: 8, right: 10, bottom: 24, left: 34 };
    const cw = w-PAD.left-PAD.right, ch = h-PAD.top-PAD.bottom;
    const N = 16;
    const xs = flakes.map(f=>f.x_um||0), ys = flakes.map(f=>f.y_um||0);
    const minX=Math.min(...xs),maxX=Math.max(...xs)+1e-9;
    const minY=Math.min(...ys),maxY=Math.max(...ys)+1e-9;
    const grid = Array.from({length:N},()=>Array(N).fill(0));
    flakes.forEach(f=>{
        const ci=Math.min(N-1,Math.floor((f.x_um-minX)/(maxX-minX)*N));
        const ri=Math.min(N-1,Math.floor((f.y_um-minY)/(maxY-minY)*N));
        grid[ri][ci]++;
    });
    const maxCell = Math.max(...grid.flat(),1);
    const bw=cw/N, bh2=ch/N;
    const heat = t => {
        const r=Math.round(Math.max(0,Math.min(255, t<0.5?0:((t-0.5)*2*255))));
        const g=Math.round(Math.max(0,Math.min(255, t<0.5?(t*2*255):((1-t)*2*255))));
        const b=Math.round(Math.max(0,Math.min(255, t<0.5?((0.5-t)*2*255):0)));
        return `rgb(${r},${g},${b})`;
    };
    grid.forEach((row,ri)=>row.forEach((count,ci)=>{
        ctx.fillStyle=heat(count/maxCell);
        ctx.fillRect(PAD.left+ci*bw, PAD.top+ri*bh2, bw, bh2);
    }));
    // Axes
    ctx.fillStyle=label; ctx.font='8px Inter'; ctx.textAlign='center'; ctx.textBaseline='top';
    ctx.fillText('X position (µm)', PAD.left+cw/2, PAD.top+ch+4);
    ctx.save(); ctx.translate(PAD.left-26, PAD.top+ch/2); ctx.rotate(-Math.PI/2);
    ctx.textAlign='center'; ctx.fillText('Y (µm)',0,0); ctx.restore();
}

// ---- Nearest-Neighbour Distance ----
function _computeNND(flakes) {
    if (flakes.length < 2) return [];
    return flakes.map((f,i) => {
        let minD = Infinity;
        flakes.forEach((g,j) => {
            if (i===j) return;
            const d = Math.hypot((f.x_um||0)-(g.x_um||0),(f.y_um||0)-(g.y_um||0));
            if (d < minD) minD = d;
        });
        return minD;
    });
}

// ---- Pair correlation g(r) ----
function _drawPairCorrelation(ctx, w, h, flakes) {
    const { grid, axis, label } = _themeColors();
    const PAD = { top: 12, right: 10, bottom: 28, left: 36 };
    const cw = w-PAD.left-PAD.right, ch = h-PAD.top-PAD.bottom;

    if (flakes.length < 3) { ctx.fillStyle=label; ctx.font='11px Inter'; ctx.textAlign='center'; ctx.fillText('Need ≥3 flakes', w/2, h/2); return; }

    // All pairwise distances
    const dists = [];
    for (let i=0;i<flakes.length;i++) for (let j=i+1;j<flakes.length;j++)
        dists.push(Math.hypot((flakes[i].x_um||0)-(flakes[j].x_um||0),(flakes[i].y_um||0)-(flakes[j].y_um||0)));

    const maxR = Math.max(...dists)*0.5, dr = maxR/12;
    const nBins = 12, gBins = Array(nBins).fill(0);
    dists.forEach(d=>{ const i=Math.floor(d/dr); if(i<nBins) gBins[i]++; });

    // Normalise by annulus area * number density
    const xs = flakes.map(f=>f.x_um||0), ys = flakes.map(f=>f.y_um||0);
    const bbArea = (Math.max(...xs)-Math.min(...xs)+1e-9)*(Math.max(...ys)-Math.min(...ys)+1e-9);
    const lambda = flakes.length / bbArea;
    const gVals = gBins.map((count,i)=>{
        const r = (i+0.5)*dr;
        const annulus = Math.PI*((r+dr)*(r+dr)-r*r);
        const expected = lambda * (flakes.length-1) / 2 * annulus;
        return expected > 0 ? count/expected : 0;
    });
    const maxG = Math.max(...gVals, 1.5);

    ctx.strokeStyle=grid; ctx.lineWidth=1;
    for (let i=1;i<=4;i++) {
        const y=PAD.top+ch-(i/4)*ch;
        ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(PAD.left+cw,y); ctx.stroke();
        ctx.fillStyle=label; ctx.font='9px Inter'; ctx.textAlign='right'; ctx.textBaseline='middle';
        ctx.fillText((maxG*i/4).toFixed(1), PAD.left-3, y);
    }
    // g(r) line
    ctx.strokeStyle='#8b5cf6'; ctx.lineWidth=1.5; ctx.beginPath();
    gVals.forEach((g,i)=>{
        const px=PAD.left+(i+0.5)*(cw/nBins), py=PAD.top+ch-(g/maxG)*ch;
        if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
    }); ctx.stroke();
    // g=1 reference
    ctx.strokeStyle='rgba(107,114,128,0.5)'; ctx.lineWidth=1; ctx.setLineDash([3,3]);
    const y1=PAD.top+ch-(1/maxG)*ch;
    ctx.beginPath(); ctx.moveTo(PAD.left,y1); ctx.lineTo(PAD.left+cw,y1); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle=label; ctx.font='9px Inter'; ctx.textBaseline='top';
    [0,0.5,1.0].forEach(s=>{
        ctx.textAlign=s===0?'left':s===1?'right':'center';
        ctx.fillText((s*maxR).toFixed(1)+'µm', PAD.left+s*cw, PAD.top+ch+4);
    });
    ctx.strokeStyle=axis; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(PAD.left,PAD.top); ctx.lineTo(PAD.left,PAD.top+ch); ctx.lineTo(PAD.left+cw,PAD.top+ch); ctx.stroke();
}

// ---- Per-image coverage bar ----
function _drawCoverageBar(ctx, w, h) {
    const { grid, axis, label } = _themeColors();
    const PAD = { top: 12, right: 10, bottom: 36, left: 36 };
    const cw = w-PAD.left-PAD.right, ch = h-PAD.top-PAD.bottom;
    const imgs = state.images.filter(img => img.flakes.length > 0);
    if (!imgs.length) { ctx.fillStyle=label; ctx.font='11px Inter'; ctx.textAlign='center'; ctx.fillText('No images with flakes', w/2, h/2); return; }
    const covs = imgs.map(img => {
        const sr = img.scaleRatio||1;
        const imgA = (img.width*img.height)/(sr*sr);
        const flakeA = img.flakes.reduce((s,f)=>s+(f.area||0),0);
        return imgA > 0 ? (flakeA/imgA*100) : 0;
    });
    const maxCov = Math.max(...covs, 1);
    const bw = cw/imgs.length;

    ctx.strokeStyle=grid; ctx.lineWidth=1;
    for (let i=1;i<=4;i++) {
        const y=PAD.top+ch-(i/4)*ch;
        ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(PAD.left+cw,y); ctx.stroke();
        ctx.fillStyle=label; ctx.font='9px Inter'; ctx.textAlign='right'; ctx.textBaseline='middle';
        ctx.fillText((maxCov*i/4).toFixed(1)+'%', PAD.left-3, y);
    }
    covs.forEach((cov,i)=>{
        const bh=(cov/maxCov)*ch, x=PAD.left+i*bw;
        ctx.fillStyle='#06b6d488'; ctx.fillRect(x+2,PAD.top+ch-bh,bw-4,bh);
        ctx.strokeStyle='#06b6d4'; ctx.lineWidth=1; ctx.strokeRect(x+2,PAD.top+ch-bh,bw-4,bh);
        ctx.fillStyle=label; ctx.font='8px Inter'; ctx.textAlign='center'; ctx.textBaseline='top';
        const nm = imgs[i].name||`Img${i+1}`;
        ctx.fillText(nm.slice(0,8), x+bw/2, PAD.top+ch+4);
        ctx.textBaseline='bottom';
        ctx.fillText(cov.toFixed(1)+'%', x+bw/2, PAD.top+ch-bh-2);
    });
    ctx.strokeStyle=axis; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(PAD.left,PAD.top); ctx.lineTo(PAD.left,PAD.top+ch); ctx.lineTo(PAD.left+cw,PAD.top+ch); ctx.stroke();
}

// ---- Pearson correlation matrix ----
function _drawCorrelationMatrix(ctx, w, h, flakes) {
    const { label } = _themeColors();
    const keys = ['Area','Length','Width','A.R.','Contrast'];
    const getVal = (f, k) => {
        if (k==='Area')     return f.area||0;
        if (k==='Length')   return f.length||0;
        if (k==='Width')    return f.width||0;
        if (k==='A.R.')     return f.length/Math.max(f.width,0.001);
        if (k==='Contrast') return f.relContrast||0;
        return 0;
    };
    const n = keys.length;
    const PAD = 36;
    const cellS = Math.min((w-PAD*2)/n, (h-PAD*2)/n);
    const offX = (w - cellS*n)/2, offY = (h - cellS*n)/2;

    const vals = keys.map(k => flakes.map(f => getVal(f,k)));
    const pearson = (a,b) => {
        const na=a.length; if (!na) return 0;
        const ma=a.reduce((s,v)=>s+v,0)/na, mb=b.reduce((s,v)=>s+v,0)/na;
        let num=0,da=0,db=0;
        for(let i=0;i<na;i++){const x=a[i]-ma,y=b[i]-mb;num+=x*y;da+=x*x;db+=y*y;}
        return da&&db ? num/Math.sqrt(da*db) : 0;
    };

    keys.forEach((kR,ri) => keys.forEach((kC,ci) => {
        const r = pearson(vals[ri], vals[ci]);
        // Color: -1=red, 0=gray, +1=blue
        const t = (r+1)/2;
        const red   = Math.round(255*(1-t)*0.9);
        const blue  = Math.round(255*t*0.9);
        const green = Math.round(80*(1-Math.abs(r)));
        ctx.fillStyle = `rgb(${red},${green},${blue})`;
        ctx.fillRect(offX+ci*cellS, offY+ri*cellS, cellS, cellS);
        ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth=0.5;
        ctx.strokeRect(offX+ci*cellS, offY+ri*cellS, cellS, cellS);
        ctx.fillStyle = Math.abs(r)>0.5 ? '#fff' : label;
        ctx.font = `${Math.round(cellS*0.28)}px Inter`;
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText(r.toFixed(2), offX+ci*cellS+cellS/2, offY+ri*cellS+cellS/2);
    }));
    // Labels
    ctx.fillStyle = label; ctx.font = `${Math.max(8,Math.round(cellS*0.25))}px Inter`;
    keys.forEach((k,i)=>{
        ctx.textAlign='right'; ctx.textBaseline='middle';
        ctx.fillText(k, offX-4, offY+i*cellS+cellS/2);
        ctx.textAlign='center'; ctx.textBaseline='bottom';
        ctx.fillText(k, offX+i*cellS+cellS/2, offY-4);
    });
}

// ---- Cross-image flake count bar ----
function _drawCrossImageBar(ctx, w, h) {
    const { grid, axis, label } = _themeColors();
    const PAD = { top: 12, right: 10, bottom: 36, left: 36 };
    const cw = w-PAD.left-PAD.right, ch = h-PAD.top-PAD.bottom;
    const imgs = state.images;
    if (!imgs.length) return;
    const counts = imgs.map(img=>img.flakes.length);
    const maxC = Math.max(...counts,1);
    const bw = cw/imgs.length;

    ctx.strokeStyle=grid; ctx.lineWidth=1;
    for (let i=1;i<=4;i++) {
        const y=PAD.top+ch-(i/4)*ch;
        ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(PAD.left+cw,y); ctx.stroke();
        ctx.fillStyle=label; ctx.font='9px Inter'; ctx.textAlign='right'; ctx.textBaseline='middle';
        ctx.fillText(Math.round(maxC*i/4), PAD.left-3, y);
    }
    counts.forEach((count,i)=>{
        const bh=(count/maxC)*ch, x=PAD.left+i*bw;
        ctx.fillStyle='#a855f788'; ctx.fillRect(x+2,PAD.top+ch-bh,bw-4,bh);
        ctx.strokeStyle='#a855f7'; ctx.lineWidth=1; ctx.strokeRect(x+2,PAD.top+ch-bh,bw-4,bh);
        ctx.fillStyle=label; ctx.font='8px Inter'; ctx.textAlign='center'; ctx.textBaseline='top';
        ctx.fillText((imgs[i].name||`Img${i+1}`).slice(0,8), x+bw/2, PAD.top+ch+4);
        ctx.textBaseline='bottom';
        ctx.fillText(count, x+bw/2, PAD.top+ch-bh-2);
    });
    ctx.strokeStyle=axis; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(PAD.left,PAD.top); ctx.lineTo(PAD.left,PAD.top+ch); ctx.lineTo(PAD.left+cw,PAD.top+ch); ctx.stroke();
}

// ============================================================
// MOTORIZED STAGE EXPORT
// ============================================================
/**
 * Sort flakes into a spiral scan order (outward from centroid of all flakes).
 * Useful for minimising stage travel on motorised stages.
 */
function spiralSortFlakes(flakes) {
    if (flakes.length < 2) return flakes;
    const cx = flakes.reduce((s, f) => s + f.x_um, 0) / flakes.length;
    const cy = flakes.reduce((s, f) => s + f.y_um, 0) / flakes.length;
    return [...flakes].sort((a, b) => {
        const ra = Math.hypot(a.x_um - cx, a.y_um - cy);
        const rb = Math.hypot(b.x_um - cx, b.y_um - cy);
        return ra - rb;
    });
}

function exportStageCoordinates(format, sortMode = 'none') {
    const imgObj = state.images.find(img => img.id === state.activeImageId);
    if (!imgObj || imgObj.flakes.length === 0) {
        showToast('No flakes to export — detect or annotate flakes first.', 'warning');
        return;
    }

    let flakes = [...imgObj.flakes];

    // Apply sort order
    switch (sortMode) {
        case 'area_desc':   flakes.sort((a, b) => b.area - a.area); break;
        case 'area_asc':    flakes.sort((a, b) => a.area - b.area); break;
        case 'tag':         flakes.sort((a, b) => (a.customTag || '').localeCompare(b.customTag || '')); break;
        case 'x_asc':       flakes.sort((a, b) => a.x_um - b.x_um); break;
        case 'y_asc':       flakes.sort((a, b) => a.y_um - b.y_um); break;
        case 'spiral':      flakes = spiralSortFlakes(flakes); break;
        case 'raster': {    // snake-row scan — sort by Y rows then alternating X direction
            flakes.sort((a, b) => a.y_um - b.y_um);
            // Group into approximate rows (within 10 µm tolerance)
            const rowTol = 10;
            const rows = []; let curRow = [flakes[0]], rowY = flakes[0].y_um;
            for (let i = 1; i < flakes.length; i++) {
                if (Math.abs(flakes[i].y_um - rowY) < rowTol) { curRow.push(flakes[i]); }
                else { rows.push(curRow); curRow = [flakes[i]]; rowY = flakes[i].y_um; }
            }
            rows.push(curRow);
            rows.forEach((row, ri) => ri % 2 === 0 ? row.sort((a,b)=>a.x_um-b.x_um) : row.sort((a,b)=>b.x_um-a.x_um));
            flakes = rows.flat();
            break;
        }
        default: break; // keep original order
    }

    let content = '', filename = '';
    const ts = new Date().toISOString();

    switch (format) {
        case 'marzhauser':
            filename = `${imgObj.name}_Marzhauser.txt`;
            content  = `; Märzhäuser TANGO stage coordinate list\n; Generated by FlakeLocator Pro  ${ts}\n; Source: ${imgObj.name}\n; Sort: ${sortMode}\n;\n; X[µm]\tY[µm]\tFlakeID\tTag\n`;
            flakes.forEach(f => {
                content += `${f.x_um.toFixed(3)}\t${f.y_um.toFixed(3)}\t${f.name}\t${f.customTag}\n`;
            });
            break;

        case 'prior':
            filename = `${imgObj.name}_Prior_ProScan.txt`;
            content  = `; Prior Scientific ProScan stage list\n; Generated by FlakeLocator Pro  ${ts}\n; Sort: ${sortMode}\n;\n`;
            flakes.forEach(f => {
                content += `P,${f.x_um.toFixed(3)},${f.y_um.toFixed(3)}\n`;
            });
            break;

        case 'renishaw':
            filename = `${imgObj.name}_Renishaw_WiRE.csv`;
            content  = `X,Y,Label\n`;
            flakes.forEach(f => {
                content += `${f.x_um.toFixed(3)},${f.y_um.toFixed(3)},"${f.name} (${f.customTag})"\n`;
            });
            break;

        case 'witec':
            filename = `${imgObj.name}_WITec_Positions.txt`;
            content  = `WITec stage positions\nGenerated by FlakeLocator Pro  ${ts}\n; Sort: ${sortMode}\n\n`;
            content  += `#\tX[µm]\tY[µm]\tLabel\n`;
            flakes.forEach((f, i) => {
                content += `${i + 1}\t${f.x_um.toFixed(3)}\t${f.y_um.toFixed(3)}\t${f.name}\n`;
            });
            break;

        default: // generic CSV
            filename = `${imgObj.name}_Stage_Coords.csv`;
            content  = `FlakeID,Name,X_um,Y_um,Length_um,Width_um,Area_um2,Layers,Tag,Notes\n`;
            flakes.forEach(f => {
                content += `"${f.id}","${f.name}",${f.x_um.toFixed(4)},${f.y_um.toFixed(4)},${f.length.toFixed(3)},${f.width.toFixed(3)},${f.area.toFixed(1)},${f.layers ?? ''},"${f.customTag}","${(f.notes || '').replace(/"/g, '""')}"\n`;
            });
    }

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href     = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast(`Stage coordinates exported (${format}, sort: ${sortMode})`, 'success');
}

function showStageExportMenu() {
    const existing = document.getElementById('stage-export-menu');
    if (existing) { existing.remove(); return; }

    const btn     = document.getElementById('btn-stage-export');
    const btnRect = btn ? btn.getBoundingClientRect() : { bottom: 60, left: 0 };

    const menu = document.createElement('div');
    menu.id = 'stage-export-menu';
    menu.style.cssText = `
        position:fixed; top:${btnRect.bottom + 6}px; left:${btnRect.left}px;
        z-index:3000; background:var(--bg-panel-solid);
        border:1px solid var(--border-color); border-radius:8px;
        box-shadow:0 8px 32px rgba(0,0,0,0.6); padding:0.4rem 0; min-width:256px;
    `;

    // Section header
    const header = document.createElement('div');
    header.className = 'stage-menu-section';
    header.textContent = 'Export Stage Coordinates As:';
    menu.appendChild(header);

    // Sort order selector
    const sortRow = document.createElement('div');
    sortRow.className = 'stage-sort-row';
    sortRow.innerHTML = `
        <span style="font-size:0.7rem; color:var(--text-dim); white-space:nowrap;">Scan order:</span>
        <select id="stage-sort-select" style="flex:1; font-size:0.7rem; padding:0.2rem 0.3rem; border-radius:5px; border:1px solid var(--border-color); background:var(--input-bg); color:var(--text-primary);">
            <option value="none">As detected</option>
            <option value="area_desc">Largest first</option>
            <option value="area_asc">Smallest first</option>
            <option value="tag">By tag (A-Z)</option>
            <option value="x_asc">Left → Right</option>
            <option value="y_asc">Top → Bottom</option>
            <option value="spiral">Spiral (centre-out)</option>
            <option value="raster">Raster (snake scan)</option>
        </select>
    `;
    menu.appendChild(sortRow);

    const divider = document.createElement('hr');
    divider.style.cssText = 'border:none; border-top:1px solid var(--border-color); margin:0.2rem 0;';
    menu.appendChild(divider);

    const formats = [
        { id: 'generic',    label: '📄 Generic CSV (all fields)' },
        { id: 'marzhauser', label: '🔬 Märzhäuser TANGO Stage' },
        { id: 'prior',      label: '🎯 Prior Scientific ProScan' },
        { id: 'renishaw',   label: '🌡️ Renishaw WiRE (.csv)' },
        { id: 'witec',      label: '🔭 WITec alpha300 Positions' },
    ];

    formats.forEach(({ id, label }) => {
        const item = document.createElement('div');
        item.className = 'stage-menu-item';
        item.style.cssText = 'padding:0.45rem 0.75rem; cursor:pointer; font-size:0.78rem; color:var(--text-primary);';
        item.textContent = label;
        item.addEventListener('mouseenter', () => item.style.background = 'var(--card-hover)');
        item.addEventListener('mouseleave', () => item.style.background = '');
        item.addEventListener('click', () => {
            const sortMode = document.getElementById('stage-sort-select')?.value || 'none';
            menu.remove();
            exportStageCoordinates(id, sortMode);
        });
        menu.appendChild(item);
    });

    document.body.appendChild(menu);

    // Flip menu if it overflows
    requestAnimationFrame(() => {
        const r = menu.getBoundingClientRect();
        if (r.right > window.innerWidth) menu.style.left = `${btnRect.right - r.width}px`;
        if (r.bottom > window.innerHeight) menu.style.top = `${btnRect.top - r.height - 6}px`;
    });

    setTimeout(() => {
        const close = (e) => {
            if (!menu.contains(e.target) && e.target !== btn) {
                menu.remove();
                document.removeEventListener('click', close, true);
            }
        };
        document.addEventListener('click', close, true);
    }, 10);
}
window.showStageExportMenu = showStageExportMenu;
window.exportStageCoordinates = exportStageCoordinates;

// ============================================================
// FLAT-FIELD ILLUMINATION CORRECTION
// ============================================================
let _flatFieldCanvas = null;

function loadFlatField(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
            _flatFieldCanvas = document.createElement('canvas');
            _flatFieldCanvas.width  = img.naturalWidth;
            _flatFieldCanvas.height = img.naturalHeight;
            _flatFieldCanvas.getContext('2d').drawImage(img, 0, 0);
            const lbl = document.getElementById('flat-field-label');
            if (lbl) lbl.textContent = `✓ ${file.name} (${img.naturalWidth}×${img.naturalHeight})`;
            const clrBtn = document.getElementById('btn-flat-field-clear');
            if (clrBtn) clrBtn.style.display = '';
            showToast(`Flat-field reference loaded: ${file.name}`, 'success');
        };
        img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
}

function applyFlatFieldToOffscreen() {
    if (!_flatFieldCanvas) {
        showToast('No flat-field reference loaded — upload a blank substrate image first.', 'warning');
        return;
    }
    if (!loadedImageEl) {
        showToast('No active substrate image loaded.', 'warning');
        return;
    }

    const w = offscreenCanvas.width;
    const h = offscreenCanvas.height;

    // Scale flat-field to match active image size
    const ffScaled = document.createElement('canvas');
    ffScaled.width  = w; ffScaled.height = h;
    ffScaled.getContext('2d').drawImage(_flatFieldCanvas, 0, 0, w, h);
    const ffData = ffScaled.getContext('2d').getImageData(0, 0, w, h).data;

    // Compute flat-field mean luminance for gain normalisation
    let ffMean = 0;
    for (let i = 0; i < ffData.length; i += 4) {
        ffMean += 0.299 * ffData[i] + 0.587 * ffData[i+1] + 0.114 * ffData[i+2];
    }
    ffMean /= (w * h);

    const src = offscreenCtx.getImageData(0, 0, w, h);
    const d   = src.data;

    for (let i = 0; i < d.length; i += 4) {
        const ffL = 0.299 * ffData[i] + 0.587 * ffData[i+1] + 0.114 * ffData[i+2] + 0.5;
        const gain = ffMean / ffL; // pixels in bright areas get smaller gain → corrects uneven light
        d[i]   = Math.max(0, Math.min(255, d[i]   * gain));
        d[i+1] = Math.max(0, Math.min(255, d[i+1] * gain));
        d[i+2] = Math.max(0, Math.min(255, d[i+2] * gain));
    }

    offscreenCtx.putImageData(src, 0, 0);
    showToast('Flat-field correction applied — illumination normalised.', 'success');
    applyOffscreenFilters();
    redraw();
}

function clearFlatField() {
    _flatFieldCanvas = null;
    const lbl = document.getElementById('flat-field-label');
    if (lbl) lbl.textContent = 'No reference loaded';
    const clrBtn = document.getElementById('btn-flat-field-clear');
    if (clrBtn) clrBtn.style.display = 'none';
    const inp = document.getElementById('flat-field-input');
    if (inp) inp.value = '';
    showToast('Flat-field reference cleared.', 'info');
}

// ============================================================
// IMAGE AUTO-STITCH WITH 2D FEATURE MATCHING (HARRIS + RANSAC)
// ============================================================

/**
 * Converts ImageData RGBA buffer to a Float32 grayscale array.
 */
function toGrayscale(data, w, h) {
    const g = new Float32Array(w * h);
    for (let n = 0; n < w * h; n++) {
        g[n] = 0.299 * data[n*4] + 0.587 * data[n*4+1] + 0.114 * data[n*4+2];
    }
    return g;
}

/**
 * Computes image gradients Ix and Iy using Sobel filters.
 */
function computeSobelGradients(gray, w, h) {
    const Ix = new Float32Array(w * h);
    const Iy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
        const rowOffset = y * w;
        const prevRowOffset = (y - 1) * w;
        const nextRowOffset = (y + 1) * w;
        for (let x = 1; x < w - 1; x++) {
            const idx = rowOffset + x;
            
            // Sobel kernels
            const g00 = gray[prevRowOffset + x - 1];
            const g01 = gray[prevRowOffset + x];
            const g02 = gray[prevRowOffset + x + 1];
            const g10 = gray[rowOffset + x - 1];
            const g12 = gray[rowOffset + x + 1];
            const g20 = gray[nextRowOffset + x - 1];
            const g21 = gray[nextRowOffset + x];
            const g22 = gray[nextRowOffset + x + 1];
            
            Ix[idx] = (g02 + 2 * g12 + g22) - (g00 + 2 * g10 + g20);
            Iy[idx] = (g20 + 2 * g21 + g22) - (g00 + 2 * g01 + g02);
        }
    }
    return { Ix, Iy };
}

/**
 * Applies a separable 2D box filter to smooth structure tensor components.
 */
function separableBoxBlur(src, w, h, radius) {
    const dst = new Float32Array(w * h);
    const size = 2 * radius + 1;
    const temp = new Float32Array(w * h);
    
    // Horizontal pass
    for (let y = 0; y < h; y++) {
        const rowOffset = y * w;
        let sum = 0;
        for (let x = 0; x < size; x++) {
            sum += src[rowOffset + Math.min(w - 1, Math.max(0, x - radius))];
        }
        for (let x = 0; x < w; x++) {
            temp[rowOffset + x] = sum / size;
            const nextX = x + radius + 1;
            const prevX = x - radius;
            sum += src[rowOffset + Math.min(w - 1, nextX)] - src[rowOffset + Math.max(0, prevX)];
        }
    }
    
    // Vertical pass
    for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let y = 0; y < size; y++) {
            sum += temp[Math.min(h - 1, Math.max(0, y - radius)) * w + x];
        }
        for (let y = 0; y < h; y++) {
            dst[y * w + x] = sum / size;
            const nextY = y + radius + 1;
            const prevY = y - radius;
            sum += temp[Math.min(h - 1, nextY) * w + x] - temp[Math.max(0, prevY) * w + x];
        }
    }
    return dst;
}

/**
 * Detects Harris corner points using NMS.
 */
function detectHarrisCorners(R, w, h, threshold, nmsRadius) {
    const corners = [];
    const border = 10;
    for (let y = border; y < h - border; y++) {
        const rowOffset = y * w;
        for (let x = border; x < w - border; x++) {
            const val = R[rowOffset + x];
            if (val < threshold) continue;
            
            // Non-Maximum Suppression (NMS)
            let isMax = true;
            for (let dy = -nmsRadius; dy <= nmsRadius; dy++) {
                const checkRowOffset = (y + dy) * w;
                for (let dx = -nmsRadius; dx <= nmsRadius; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    if (R[checkRowOffset + x + dx] > val) {
                        isMax = false;
                        break;
                    }
                }
                if (!isMax) break;
            }
            
            if (isMax) {
                corners.push({ x, y, r: val });
            }
        }
    }
    return corners;
}

/**
 * Extracts normalized 11x11 patches around corner keypoints.
 */
function extractPatchDescriptor(gray, w, h, cx, cy) {
    const radius = 5;
    const size = 2 * radius + 1; // 11×11 = 121 elements
    // Bounds check — skip corners too close to the image border
    if (cx - radius < 0 || cx + radius >= w || cy - radius < 0 || cy + radius >= h) return null;

    const patch = new Float32Array(size * size);
    let sum = 0;

    for (let dy = -radius; dy <= radius; dy++) {
        const rowOffset = (cy + dy) * w;
        const patchRowOffset = (dy + radius) * size;
        for (let dx = -radius; dx <= radius; dx++) {
            const val = gray[rowOffset + cx + dx];
            patch[patchRowOffset + dx + radius] = val;
            sum += val;
        }
    }

    const mean = sum / (size * size);
    let sumSqDiff = 0;
    for (let i = 0; i < size * size; i++) {
        const diff = patch[i] - mean;
        sumSqDiff += diff * diff;
    }
    const stdDev = Math.sqrt(sumSqDiff / (size * size));
    if (stdDev < 1e-4) return null; // flat / featureless patch — discard

    const desc = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) desc[i] = (patch[i] - mean) / stdDev;
    return desc;
}

/**
 * Squared L2 distance between two normalized patch descriptors.
 * Using squared distance avoids sqrt and is sufficient for comparisons.
 */
function descriptorL2Distance(d1, d2) {
    let sum = 0;
    const len = d1.length;
    for (let i = 0; i < len; i++) {
        const diff = d1[i] - d2[i];
        sum += diff * diff;
    }
    return sum;
}

/**
 * Mutual best-match (cross-check) keypoint matching.
 * Only accepts a match if A→B and B→A both agree, and applies
 * Lowe's ratio test to reject ambiguous matches.
 */
function matchKeypoints(featA, featB) {
    // Filter out features with null descriptors
    const validA = featA.filter(f => f.desc !== null);
    const validB = featB.filter(f => f.desc !== null);
    if (!validA.length || !validB.length) return [];

    const matches = [];
    // Lowe's ratio threshold: best match must be clearly better than second-best
    const RATIO_THRESH = 0.75;

    const bestBForA   = new Int32Array(validA.length).fill(-1);
    const minDistForA = new Float32Array(validA.length).fill(Infinity);

    for (let i = 0; i < validA.length; i++) {
        const descA = validA[i].desc;
        let d1 = Infinity, d2 = Infinity, bestJ = -1;
        for (let j = 0; j < validB.length; j++) {
            const d = descriptorL2Distance(descA, validB[j].desc);
            if (d < d1) { d2 = d1; d1 = d; bestJ = j; }
            else if (d < d2) { d2 = d; }
        }
        // Ratio test
        if (d1 < RATIO_THRESH * RATIO_THRESH * d2) {
            bestBForA[i]   = bestJ;
            minDistForA[i] = d1;
        }
    }

    // Cross-check: B must also vote for A
    const bestAForB = new Int32Array(validB.length).fill(-1);
    for (let j = 0; j < validB.length; j++) {
        const descB = validB[j].desc;
        let minDist = Infinity, bestI = -1;
        for (let i = 0; i < validA.length; i++) {
            const d = descriptorL2Distance(validA[i].desc, descB);
            if (d < minDist) { minDist = d; bestI = i; }
        }
        bestAForB[j] = bestI;
    }

    for (let i = 0; i < validA.length; i++) {
        const j = bestBForA[i];
        if (j !== -1 && bestAForB[j] === i) {
            matches.push({ a: validA[i], b: validB[j], dist: minDistForA[i] });
        }
    }
    return matches;
}

/**
 * Robustly estimates translation offset (dx, dy) from A to B using RANSAC.
 * A translation model needs only 1 point match.
 */
function solveRansacTranslation(matches, inlierThreshold = 5.0) {
    if (matches.length === 0) return { dx: 0, dy: 0, inliers: [] };
    
    let bestInliers = [];
    let bestDx = 0;
    let bestDy = 0;
    
    for (let i = 0; i < matches.length; i++) {
        const hyp = matches[i];
        // Translation vector from A to B
        const dx = hyp.a.x - hyp.b.x;
        const dy = hyp.a.y - hyp.b.y;
        
        const inliers = [];
        for (let j = 0; j < matches.length; j++) {
            const m = matches[j];
            const mx = m.a.x - m.b.x;
            const my = m.a.y - m.b.y;
            
            const errX = mx - dx;
            const errY = my - dy;
            const dist = Math.sqrt(errX * errX + errY * errY);
            if (dist <= inlierThreshold) {
                inliers.push(m);
            }
        }
        
        if (inliers.length > bestInliers.length) {
            bestInliers = inliers;
            bestDx = dx;
            bestDy = dy;
        }
    }
    
    // Average inliers to get a sub-pixel estimate
    if (bestInliers.length > 0) {
        let sumDx = 0;
        let sumDy = 0;
        for (const m of bestInliers) {
            sumDx += (m.a.x - m.b.x);
            sumDy += (m.a.y - m.b.y);
        }
        bestDx = sumDx / bestInliers.length;
        bestDy = sumDy / bestInliers.length;
    }
    
    return {
        dx: bestDx,
        dy: bestDy,
        inliers: bestInliers
    };
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * AUTO-STITCH  —  Harris + Patch Descriptor + Mutual NN + RANSAC
 * ─────────────────────────────────────────────────────────────────────────
 * Pipeline per image pair:
 *   1. Downsample to ≤ 600px wide  (keeps memory < 30 MB per image)
 *   2. Sobel gradients → structure tensor → Harris corner response
 *   3. Non-maximum suppression → top-250 corners
 *   4. Extract 11×11 zero-mean-normalised patch descriptor per corner
 *   5. Mutual best-match + Lowe's ratio test  → candidate correspondences
 *   6. RANSAC translation consensus           → (dx, dy) + inlier count
 *   7. Scale offset back to full resolution
 *
 * Graph-based placement: images are placed greedily starting from the
 * anchor (first image). Any image with no overlapping features falls back
 * to simple sequential side-by-side placement.
 * ─────────────────────────────────────────────────────────────────────────
 */
function autoStitchImages() {
    if (state.images.length < 2) {
        showToast('Load at least 2 images to auto-stitch.', 'warning');
        return;
    }

    // Prevent re-entry
    if (autoStitchImages._running) return;
    autoStitchImages._running = true;

    showToast(`Stitching ${state.images.length} images — detecting features…`, 'info');

    // Yield to the browser so the toast renders before heavy computation
    setTimeout(() => {
        try {
            _runFeatureStitch();
        } catch(e) {
            console.error('[Stitch]', e);
            showToast('Auto-stitch failed: ' + e.message, 'error');
        } finally {
            autoStitchImages._running = false;
        }
    }, 60);
}

function _runFeatureStitch() {
    const imgs  = state.images;
    // ── STEP 1: extract features for every image at reduced scale ──────────
    const MAX_W  = 600;                    // work at ≤600px wide
    const imgFeatures = imgs.map(imgObj => {
        if (!imgObj.imageEl) return null;
        try {
            const scale = Math.min(1.0, MAX_W / imgObj.width);
            const sw    = Math.max(1, Math.round(imgObj.width  * scale));
            const sh    = Math.max(1, Math.round(imgObj.height * scale));

            // Draw at reduced resolution
            const cv = document.createElement('canvas');
            cv.width = sw; cv.height = sh;
            cv.getContext('2d').drawImage(imgObj.imageEl, 0, 0, sw, sh);
            const rawData = cv.getContext('2d').getImageData(0, 0, sw, sh).data;

            // Grayscale (0–255 float)
            const gray = new Float32Array(sw * sh);
            for (let n = 0; n < sw * sh; n++) {
                gray[n] = 0.299 * rawData[n*4] + 0.587 * rawData[n*4+1] + 0.114 * rawData[n*4+2];
            }

            // Sobel gradients
            const { Ix, Iy } = computeSobelGradients(gray, sw, sh);

            // Structure tensor components
            const Ixx = new Float32Array(sw * sh);
            const Iyy = new Float32Array(sw * sh);
            const Ixy = new Float32Array(sw * sh);
            for (let j = 0; j < sw * sh; j++) {
                Ixx[j] = Ix[j] * Ix[j];
                Iyy[j] = Iy[j] * Iy[j];
                Ixy[j] = Ix[j] * Iy[j];
            }

            // Smooth structure tensor (box blur radius 2)
            const sIxx = separableBoxBlur(Ixx, sw, sh, 2);
            const sIyy = separableBoxBlur(Iyy, sw, sh, 2);
            const sIxy = separableBoxBlur(Ixy, sw, sh, 2);

            // Harris response  R = det(M) − k·trace(M)²
            const k = 0.04;
            const R = new Float32Array(sw * sh);
            let maxR = 0;
            for (let j = 0; j < sw * sh; j++) {
                R[j] = (sIxx[j]*sIyy[j] - sIxy[j]*sIxy[j]) - k*(sIxx[j]+sIyy[j])*(sIxx[j]+sIyy[j]);
                if (R[j] > maxR) maxR = R[j];
            }

            // NMS + threshold
            const thresh  = Math.max(1e-3, maxR * 0.01);
            const corners = detectHarrisCorners(R, sw, sh, thresh, 3);
            corners.sort((a, b) => b.r - a.r);
            const topN = corners.slice(0, 250);

            // Patch descriptors (null for border/flat patches — filtered in matching)
            const features = topN.map(c => ({
                x:    c.x,
                y:    c.y,
                xFull: Math.round(c.x / scale),   // coords in original resolution
                yFull: Math.round(c.y / scale),
                desc: extractPatchDescriptor(gray, sw, sh, c.x, c.y)
            })).filter(f => f.desc !== null);

            console.log(`[Stitch] ${imgObj.name}: ${features.length} features @ ${sw}×${sh} (scale ${scale.toFixed(2)})`);
            return { imgObj, features, scale };
        } catch(e) {
            console.error('[Stitch] feature extract failed:', imgObj.name, e);
            return null;
        }
    });

    // ── STEP 2: graph-based greedy placement ───────────────────────────────
    // Anchor = first image; keep offsets in full-resolution pixels
    const placed = new Set([imgs[0].id]);
    imgs[0].offset = imgs[0].offset || { x: 0, y: 0 };

    let anyProgress = true;
    let stitchedPairs = 0;

    while (anyProgress) {
        anyProgress = false;
        let best = null; // { u, p, dx, dy, nInliers }

        for (let u = 0; u < imgs.length; u++) {
            if (placed.has(imgs[u].id) || !imgFeatures[u]) continue;
            for (let p = 0; p < imgs.length; p++) {
                if (!placed.has(imgs[p].id) || !imgFeatures[p]) continue;

                const fP = imgFeatures[p].features;
                const fU = imgFeatures[u].features;
                if (fP.length < 6 || fU.length < 6) continue;

                const rawMatches = matchKeypoints(fP, fU);
                if (rawMatches.length < 4) continue;

                // RANSAC on full-resolution coordinates
                const fullMatches = rawMatches.map(m => ({
                    a: { x: m.a.xFull, y: m.a.yFull },
                    b: { x: m.b.xFull, y: m.b.yFull },
                    dist: m.dist
                }));
                const ransac = solveRansacTranslation(fullMatches, 8.0);
                if (ransac.inliers.length >= 4) {
                    if (!best || ransac.inliers.length > best.nInliers) {
                        best = { u, p, dx: ransac.dx, dy: ransac.dy, nInliers: ransac.inliers.length };
                    }
                }
            }
        }

        if (best) {
            const uImg = imgs[best.u];
            const pImg = imgs[best.p];
            // Translation: a feature at pImg-pixel (fx,fy) appears at uImg-pixel (gx,gy)
            // dx = fx - gx  (from RANSAC: a.x - b.x)
            // canvas_pos = pImg.offset + (fx, fy) = uImg.offset + (gx, gy)
            // → uImg.offset = pImg.offset + (fx - gx) = pImg.offset + (dx, dy)
            uImg.offset = {
                x: Math.round((pImg.offset.x || 0) + best.dx),
                y: Math.round((pImg.offset.y || 0) + best.dy)
            };
            placed.add(uImg.id);
            anyProgress = true;
            stitchedPairs++;
            console.log(`[Stitch] ${uImg.name} → ${pImg.name}  offset=(${uImg.offset.x},${uImg.offset.y})  inliers=${best.nInliers}`);
        }
    }

    // ── STEP 3: fallback sequential placement for isolated images ──────────
    let fallbackCount = 0;
    for (let i = 0; i < imgs.length; i++) {
        if (!placed.has(imgs[i].id)) {
            const prev = i > 0 ? imgs[i-1] : null;
            imgs[i].offset = {
                x: prev ? (prev.offset.x || 0) + prev.width + 40 : 0,
                y: prev ? (prev.offset.y || 0) : 0
            };
            placed.add(imgs[i].id);
            fallbackCount++;
        }
    }

    redraw();
    renderSubstrateList();

    // Result toast
    if (stitchedPairs === 0 && fallbackCount === imgs.length - 1) {
        showToast('No overlapping features found — images placed sequentially. Try adjusting overlap or image contrast.', 'warning');
    } else if (fallbackCount > 0) {
        showToast(`Stitched ${stitchedPairs} pair(s). ${fallbackCount} image(s) had no matches and were placed sequentially.`, 'warning');
    } else {
        showToast(`✓ Stitched all ${imgs.length} images via feature matching (${stitchedPairs} pair${stitchedPairs>1?'s':''}).`, 'success');
    }
}

// ============================================================
// ADVANCED DETECTION: WATERSHED-LIKE BLOB SPLITTING
// ============================================================
/**
 * Takes a list of flakes produced by autoDetectAllFlakes and splits those
 * that are likely merged blobs (very high aspect ratio OR area >> median)
 * using a simple erosion-then-flood approach.  Called automatically at the
 * end of autoDetectAllFlakes if state.filters.watershedSplit === true.
 *
 * This is a lightweight JS approximation — for exact watershed use the
 * Python CLI (flake_analyzer.py) with opencv's watershed function.
 */
function applyWatershedSplit(imgObj, rawData, w, h) {
    if (!imgObj || !imgObj.flakes || imgObj.flakes.length === 0) return;

    const areas   = imgObj.flakes.map(f => f.area);
    const sorted  = [...areas].sort((a, b) => a - b);
    const medianA = sorted[Math.floor(sorted.length / 2)];
    const splitThresh = Math.max(medianA * 4, state.filters.minSize * 8); // blobs 4× median are suspect

    const toSplit = imgObj.flakes.filter(f => f.area > splitThresh && f.length / f.width > 2.5);
    if (toSplit.length === 0) return;

    toSplit.forEach(bigFlake => {
        // Find the pixels belonging to this flake (bounding box + contour)
        const bb = bigFlake.boundingBox;
        if (!bb) return;

        const cx1 = Math.round(bb.minX + (bb.maxX - bb.minX) * 0.25);
        const cx2 = Math.round(bb.minX + (bb.maxX - bb.minX) * 0.75);
        const cy  = Math.round((bb.minY + bb.maxY) / 2);

        // Create two child flakes by halving the bounding box at the narrow waist
        const halfLen    = Math.max(bigFlake.length / 2, state.filters.minSize / (state.scaleRatio || 1));
        const halfArea   = bigFlake.area / 2;
        const physLeft   = pixelToPhysical(cx1, cy);
        const physRight  = pixelToPhysical(cx2, cy);

        const classL = classifyFlakeThickness(
            rawData[(cy * w + cx1) * 4],
            rawData[(cy * w + cx1) * 4 + 1],
            rawData[(cy * w + cx1) * 4 + 2]
        );
        const classR = classifyFlakeThickness(
            rawData[(cy * w + cx2) * 4],
            rawData[(cy * w + cx2) * 4 + 1],
            rawData[(cy * w + cx2) * 4 + 2]
        );

        // Remove the original merged flake and insert the two halves
        const idx = imgObj.flakes.indexOf(bigFlake);
        if (idx === -1) return;

        const mkFlake = (cx, cy, phys, cls, suffix) => ({
            id:          `${bigFlake.id}_${suffix}`,
            name:        `${bigFlake.name}${suffix}`,
            color:       cls.color,
            type:        bigFlake.type,
            points:      bigFlake.points, // shared outline (approximate)
            centroid:    { x: cx, y: cy },
            boundingBox: bigFlake.boundingBox,
            orientedBox: bigFlake.orientedBox,
            length:      halfLen,
            width:       bigFlake.width,
            area:        halfArea,
            orientation: bigFlake.orientation,
            x_um:        phys.x,
            y_um:        phys.y,
            customTag:   cls.tag,
            layers:      cls.layers,
            relContrast: cls.relContrast,
            notes:       ''
        });

        imgObj.flakes.splice(idx, 1, mkFlake(cx1, cy, physLeft, classL, 'a'), mkFlake(cx2, cy, physRight, classR, 'b'));
    });
}

// ============================================================
// THEME INIT
// ============================================================
document.body.setAttribute('data-theme', 'light');
