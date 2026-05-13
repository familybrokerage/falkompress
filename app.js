/* Falkompress — PDF tools, entirely on-device.
   Tabs: Compress | Pages | Merge | Split | Unlock
*/
(function() {
  'use strict';

  // ---------------------------------------------------------------------------
  // Shared utilities
  // ---------------------------------------------------------------------------

  const $ = id => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);

  const PRESETS = {
    high:   { maxDim: 3000, jpegQuality: 0.85 },
    medium: { maxDim: 2000, jpegQuality: 0.65 },
    low:    { maxDim: 1200, jpegQuality: 0.40 }
  };

  const RING_CIRCUMFERENCE = 2 * Math.PI * 52;

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function setRing(circleEl, pctEl, statusEl, pct, status) {
    const offset = RING_CIRCUMFERENCE - (pct / 100) * RING_CIRCUMFERENCE;
    if (circleEl) circleEl.style.strokeDashoffset = offset;
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';
    if (status && statusEl) statusEl.textContent = status;
  }

  function parseRanges(rangeStr, maxPage) {
    const pages = [];
    for (const part of rangeStr.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (trimmed.includes('-')) {
        const [s, e] = trimmed.split('-', 2);
        const start = parseInt(s.trim(), 10) - 1;
        const end = parseInt(e.trim(), 10) - 1;
        if (isNaN(start) || isNaN(end) || start < 0 || end >= maxPage || start > end) {
          throw new Error(`Invalid range "${trimmed}" (pages 1–${maxPage})`);
        }
        for (let i = start; i <= end; i++) pages.push(i);
      } else {
        const p = parseInt(trimmed, 10) - 1;
        if (isNaN(p) || p < 0 || p >= maxPage) {
          throw new Error(`Invalid page "${trimmed}" (pages 1–${maxPage})`);
        }
        pages.push(p);
      }
    }
    return pages;
  }

  function showError(id, msg) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.add('visible');
  }
  function hideError(id) {
    const el = $(id);
    if (el) el.classList.remove('visible');
  }

  // Download / share
  function downloadBlob(bytes, filename, mime = 'application/pdf') {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      document.body.removeChild(a);
    }, 1000);
  }

  async function shareFile(bytes, filename, mime = 'application/pdf') {
    try {
      const file = new File([bytes], filename, { type: mime });
      const data = { files: [file] };
      if (navigator.canShare && navigator.canShare(data)) {
        await navigator.share(data);
        return true;
      } else {
        downloadBlob(bytes, filename, mime);
        return true;
      }
    } catch (err) {
      if (err.name === 'AbortError') return true; // user cancelled
      throw err;
    }
  }

  // Promise-based password modal
  function promptPassword(filename) {
    return new Promise((resolve) => {
      const modal = $('pwModal');
      const sub = $('pwModalSub');
      const input = $('pwInput');
      const okBtn = $('pwOk');
      const cancelBtn = $('pwCancel');

      sub.textContent = `Enter the password for "${filename}".`;
      input.value = '';
      modal.classList.add('visible');
      document.body.classList.add('modal-open');
      setTimeout(() => input.focus(), 100);

      const close = (val) => {
        modal.classList.remove('visible');
        document.body.classList.remove('modal-open');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKey);
        resolve(val);
      };
      const onOk = () => close(input.value);
      const onCancel = () => close(null);
      const onKey = (e) => { if (e.key === 'Enter') onOk(); };

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      input.addEventListener('keydown', onKey);
    });
  }

  // Promise-based insert-range modal
  function promptInsertRange(filename, totalPages) {
    return new Promise((resolve) => {
      const modal = $('insertModal');
      const sub = $('insertModalSub');
      const input = $('insertRange');
      const okBtn = $('insertOk');
      const cancelBtn = $('insertCancel');

      sub.textContent = `${filename} — ${totalPages} page${totalPages !== 1 ? 's' : ''}.`;
      input.value = '';
      input.placeholder = totalPages > 1 ? `1-${totalPages}` : '1';
      modal.classList.add('visible');
      document.body.classList.add('modal-open');
      setTimeout(() => input.focus(), 100);

      const close = (val) => {
        modal.classList.remove('visible');
        document.body.classList.remove('modal-open');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKey);
        resolve(val);
      };
      const onOk = () => {
        const raw = input.value.trim();
        if (!raw) { close(Array.from({ length: totalPages }, (_, i) => i)); return; }
        try {
          const pages = parseRanges(raw, totalPages);
          close(pages);
        } catch (err) {
          alert(err.message);
        }
      };
      const onCancel = () => close(null);
      const onKey = (e) => { if (e.key === 'Enter') onOk(); };

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      input.addEventListener('keydown', onKey);
    });
  }

  // ---------------------------------------------------------------------------
  // Tab routing
  // ---------------------------------------------------------------------------

  function showScreen(tabId, screenPrefix) {
    const tab = $('tab' + tabId);
    if (!tab) return;
    tab.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = tab.querySelector(`[id^="${screenPrefix}"]`);
    if (target) target.classList.add('active');
  }
  function setScreen(prefix, suffix) {
    // prefix is the screen id prefix e.g. "cmp", suffix is "Select" / "Config" / "Progress" / "Result"
    const all = document.querySelectorAll(`[id^="${prefix}"].screen`);
    all.forEach(s => s.classList.remove('active'));
    const target = $(prefix + suffix);
    if (target) target.classList.add('active');
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    document.querySelectorAll('.tab-bar-item').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    // Lazy-load pdf.js when entering Pages tab
    if (name === 'pages') ensurePdfJs();
  }

  document.querySelectorAll('.tab-bar-item').forEach(item => {
    item.addEventListener('click', () => switchTab(item.dataset.tab));
  });

  // ---------------------------------------------------------------------------
  // pdf.js lazy-loader (for thumbnail rendering in Pages tab)
  // ---------------------------------------------------------------------------

  let pdfJsReady = null;
  function ensurePdfJs() {
    if (pdfJsReady) return pdfJsReady;
    pdfJsReady = new Promise((resolve, reject) => {
      const PDFJS_VER = '3.11.174';  // last UMD build before pdf.js went ESM-only
      const s = document.createElement('script');
      s.src = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.min.js`;
      s.onload = () => {
        try {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.worker.min.js`;
          resolve();
        } catch (e) { reject(e); }
      };
      s.onerror = () => reject(new Error('Failed to load pdf.js'));
      document.head.appendChild(s);
    });
    return pdfJsReady;
  }

  // ---------------------------------------------------------------------------
  // Compress tab (existing functionality, lightly refactored)
  // ---------------------------------------------------------------------------

  const compress = (() => {
    let selectedFile = null;
    let selectedQuality = 'medium';
    let compressedBytes = null;
    let compressedFileName = '';

    $('btnCmpSelect').addEventListener('click', () => $('cmpFile').click());
    $('btnCmpChange').addEventListener('click', () => { $('cmpFile').value = ''; $('cmpFile').click(); });

    $('cmpFile').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        alert('Please select a PDF file.');
        return;
      }
      selectedFile = file;
      $('cmpFileName').textContent = file.name;
      $('cmpFileSize').textContent = formatSize(file.size);
      hideError('cmpError');
      setScreen('cmp', 'Config');
    });

    document.querySelectorAll('#cmpQuality .quality-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#cmpQuality .quality-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedQuality = btn.dataset.quality;
      });
    });

    function setProg(pct, status) {
      setRing($('cmpProgressCircle'), $('cmpProgressPct'), $('cmpProgressStatus'), pct, status);
    }

    $('btnCmpRun').addEventListener('click', async () => {
      if (!selectedFile) return;
      hideError('cmpError');
      setScreen('cmp', 'Progress');
      setProg(0, 'Reading file…');

      try {
        const arrayBuffer = await selectedFile.arrayBuffer();
        const inputBytes = new Uint8Array(arrayBuffer);
        setProg(10, 'Parsing PDF…');

        const { PDFDocument, PDFName, PDFNumber } = PDFLib;
        const pdfDoc = await PDFDocument.load(inputBytes, { ignoreEncryption: true });

        setProg(15, 'Stripping metadata…');
        pdfDoc.setTitle(''); pdfDoc.setAuthor(''); pdfDoc.setSubject('');
        pdfDoc.setKeywords([]); pdfDoc.setCreator(''); pdfDoc.setProducer('');

        setProg(20, 'Scanning for images…');
        const preset = PRESETS[selectedQuality];
        const canvas = $('imgCanvas');
        const ctx = canvas.getContext('2d');

        const enumeratedObjects = pdfDoc.context.enumerateIndirectObjects();
        const imageObjects = [];
        for (const [ref, obj] of enumeratedObjects) {
          try {
            if (obj instanceof PDFLib.PDFRawStream || (obj && obj.dict)) {
              const dict = obj.dict || obj;
              if (dict && typeof dict.get === 'function') {
                const subtype = dict.get(PDFName.of('Subtype'));
                if (subtype && subtype.toString() === '/Image') {
                  imageObjects.push({ ref, stream: obj, dict });
                }
              }
            }
          } catch (_) { /* skip */ }
        }

        const totalImages = imageObjects.length;
        let processedImages = 0;

        for (const imgObj of imageObjects) {
          processedImages++;
          const pct = 20 + (processedImages / Math.max(totalImages, 1)) * 60;
          setProg(pct, `Processing image ${processedImages} of ${totalImages}…`);

          try {
            const dict = imgObj.dict;
            const width = dict.get(PDFName.of('Width'));
            const height = dict.get(PDFName.of('Height'));
            if (!width || !height) continue;
            const w = width instanceof PDFNumber ? width.asNumber()
              : (typeof width.value === 'function' ? width.value() : parseInt(width.toString()));
            const h = height instanceof PDFNumber ? height.asNumber()
              : (typeof height.value === 'function' ? height.value() : parseInt(height.toString()));
            if (isNaN(w) || isNaN(h) || w < 10 || h < 10) continue;

            const filter = dict.get(PDFName.of('Filter'));
            const filterStr = filter ? filter.toString() : '';
            const colorSpace = dict.get(PDFName.of('ColorSpace'));
            const colorSpaceStr = colorSpace ? colorSpace.toString() : '/DeviceRGB';
            const bitsPerComponent = dict.get(PDFName.of('BitsPerComponent'));
            const bpc = bitsPerComponent
              ? (bitsPerComponent instanceof PDFNumber ? bitsPerComponent.asNumber() : parseInt(bitsPerComponent.toString()))
              : 8;

            let rawData;
            if (imgObj.stream && imgObj.stream.contents) rawData = imgObj.stream.contents;
            else if (imgObj.stream && imgObj.stream.getContents) rawData = imgObj.stream.getContents();
            else continue;
            if (!rawData || rawData.length < 100) continue;

            let imageData = null;

            if (filterStr.includes('DCTDecode')) {
              try {
                const blob = new Blob([rawData], { type: 'image/jpeg' });
                const imgBitmap = await createImageBitmap(blob);
                imageData = { bitmap: imgBitmap, origW: imgBitmap.width, origH: imgBitmap.height };
              } catch (_) { continue; }
            } else if (filterStr.includes('FlateDecode')
                       && !filterStr.includes('CCITTFaxDecode')
                       && !filterStr.includes('JBIG2Decode')) {
              try {
                const decoded = pako.inflate(rawData);
                let channels = 3;
                if (colorSpaceStr.includes('Gray') || colorSpaceStr.includes('CalGray')) channels = 1;
                else if (colorSpaceStr.includes('CMYK')) channels = 4;
                else if (colorSpaceStr.includes('RGB') || colorSpaceStr.includes('CalRGB')) channels = 3;

                const expectedLen = w * h * channels * (bpc / 8);
                if (decoded.length < expectedLen * 0.8 || decoded.length > expectedLen * 1.5) continue;

                const pixelData = new Uint8ClampedArray(w * h * 4);
                for (let i = 0; i < w * h; i++) {
                  if (channels === 3) {
                    pixelData[i*4]   = decoded[i*3];
                    pixelData[i*4+1] = decoded[i*3+1];
                    pixelData[i*4+2] = decoded[i*3+2];
                    pixelData[i*4+3] = 255;
                  } else if (channels === 1) {
                    const v = decoded[i];
                    pixelData[i*4] = pixelData[i*4+1] = pixelData[i*4+2] = v;
                    pixelData[i*4+3] = 255;
                  } else if (channels === 4) {
                    const c = decoded[i*4] / 255, m = decoded[i*4+1] / 255,
                          yc = decoded[i*4+2] / 255, k = decoded[i*4+3] / 255;
                    pixelData[i*4]   = 255 * (1-c) * (1-k);
                    pixelData[i*4+1] = 255 * (1-m) * (1-k);
                    pixelData[i*4+2] = 255 * (1-yc) * (1-k);
                    pixelData[i*4+3] = 255;
                  }
                }
                const imgData = new ImageData(pixelData, w, h);
                canvas.width = w; canvas.height = h;
                ctx.putImageData(imgData, 0, 0);
                const bmp = await createImageBitmap(canvas);
                imageData = { bitmap: bmp, origW: w, origH: h };
              } catch (_) { continue; }
            } else if (!filterStr || filterStr === '/' || filterStr === '[]') {
              try {
                let channels = 3;
                if (colorSpaceStr.includes('Gray')) channels = 1;
                const pixelData = new Uint8ClampedArray(w * h * 4);
                for (let i = 0; i < w * h; i++) {
                  if (channels === 3) {
                    pixelData[i*4]   = rawData[i*3];
                    pixelData[i*4+1] = rawData[i*3+1];
                    pixelData[i*4+2] = rawData[i*3+2];
                    pixelData[i*4+3] = 255;
                  } else {
                    pixelData[i*4] = pixelData[i*4+1] = pixelData[i*4+2] = rawData[i];
                    pixelData[i*4+3] = 255;
                  }
                }
                const imgData = new ImageData(pixelData, w, h);
                canvas.width = w; canvas.height = h;
                ctx.putImageData(imgData, 0, 0);
                const bmp = await createImageBitmap(canvas);
                imageData = { bitmap: bmp, origW: w, origH: h };
              } catch (_) { continue; }
            } else {
              continue;
            }

            if (!imageData) continue;

            let newW = imageData.origW, newH = imageData.origH;
            const maxDim = preset.maxDim;
            if (newW > maxDim || newH > maxDim) {
              const scale = maxDim / Math.max(newW, newH);
              newW = Math.round(newW * scale);
              newH = Math.round(newH * scale);
            }

            const minWorthwhile = filterStr.includes('DCTDecode')
              && newW >= imageData.origW && newH >= imageData.origH;

            canvas.width = newW; canvas.height = newH;
            ctx.clearRect(0, 0, newW, newH);
            ctx.drawImage(imageData.bitmap, 0, 0, newW, newH);
            const jpegDataUrl = canvas.toDataURL('image/jpeg', preset.jpegQuality);
            const jpegBase64 = jpegDataUrl.split(',')[1];
            const jpegBinary = Uint8Array.from(atob(jpegBase64), c => c.charCodeAt(0));

            if (minWorthwhile && jpegBinary.length >= rawData.length * 0.95) continue;

            const newDict = imgObj.stream.dict.clone(pdfDoc.context);
            newDict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
            newDict.set(PDFName.of('Width'), PDFLib.PDFNumber.of(newW));
            newDict.set(PDFName.of('Height'), PDFLib.PDFNumber.of(newH));
            newDict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
            newDict.set(PDFName.of('BitsPerComponent'), PDFLib.PDFNumber.of(8));
            newDict.set(PDFName.of('Length'), PDFLib.PDFNumber.of(jpegBinary.length));
            newDict.delete(PDFName.of('DecodeParms'));
            newDict.delete(PDFName.of('Predictor'));

            const newStream = PDFLib.PDFRawStream.of(newDict, jpegBinary);
            pdfDoc.context.assign(imgObj.ref, newStream);
            imageData.bitmap.close && imageData.bitmap.close();
          } catch (_) { continue; }
        }

        setProg(85, 'Saving compressed PDF…');
        const savedBytes = await pdfDoc.save({ useObjectStreams: true });
        compressedBytes = savedBytes;

        setProg(95, 'Finalizing…');

        const origSize = selectedFile.size;
        const newSize = compressedBytes.length;
        const reduction = origSize > 0 ? ((origSize - newSize) / origSize * 100) : 0;
        const saved = origSize - newSize;

        $('cmpResOrig').textContent = formatSize(origSize);
        $('cmpResNew').textContent = formatSize(newSize);
        if (reduction > 0) {
          $('cmpResRatio').textContent = reduction.toFixed(1) + '%';
          $('cmpResSaved').textContent = formatSize(saved) + ' saved';
        } else {
          $('cmpResRatio').textContent = '0%';
          $('cmpResSaved').textContent = 'File could not be reduced further';
        }

        const baseName = selectedFile.name.replace(/\.pdf$/i, '');
        compressedFileName = baseName + '_compressed.pdf';

        setProg(100, 'Done!');
        await new Promise(r => setTimeout(r, 400));
        hideError('cmpResError');
        setScreen('cmp', 'Result');

      } catch (err) {
        console.error('Compression error:', err);
        setScreen('cmp', 'Config');
        showError('cmpError', 'Compression failed: ' + (err.message || 'Unknown error. The PDF may be encrypted or malformed.'));
      }
    });

    $('btnCmpDownload').addEventListener('click', () => {
      if (!compressedBytes) return;
      try { downloadBlob(compressedBytes, compressedFileName); }
      catch (err) { showError('cmpResError', 'Download failed: ' + err.message); }
    });

    $('btnCmpShare').addEventListener('click', async () => {
      if (!compressedBytes) return;
      try { await shareFile(compressedBytes, compressedFileName); }
      catch (err) { showError('cmpResError', 'Share failed: ' + err.message); }
    });

    $('btnCmpAgain').addEventListener('click', () => {
      selectedFile = null; compressedBytes = null; compressedFileName = '';
      $('cmpFile').value = '';
      setProg(0, 'Preparing…');
      setScreen('cmp', 'Select');
    });
  })();

  // ---------------------------------------------------------------------------
  // Pages tab — delete, insert, rearrange
  // ---------------------------------------------------------------------------

  const pages = (() => {
    let sourceFile = null;
    // Map of cached uploaded files: { key: { name, bytes, pdf (pdf-lib), pdfjsDoc, pageCount } }
    const sources = new Map();
    // Operations: ordered list of { sourceKey, pageIdx }
    let operations = [];
    let originalCount = 0;
    let pendingInsertAfterIdx = null;
    let outputBytes = null;
    let outputFileName = '';
    let editorMounted = false;

    $('btnPgSelect').addEventListener('click', () => $('pgFile').click());

    $('pgFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        alert('Please select a PDF file.');
        return;
      }
      sourceFile = file;
      hideError('pgError');
      try {
        await ensurePdfJs();
        await loadSource('source', file);
        operations = [];
        for (let i = 0; i < sources.get('source').pageCount; i++) {
          operations.push({ sourceKey: 'source', pageIdx: i });
        }
        originalCount = operations.length;
        setScreen('pg', 'Editor');
        renderList();
      } catch (err) {
        console.error(err);
        alert('Could not open PDF: ' + err.message);
      }
    });

    $('pgInsertFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      $('pgInsertFile').value = '';
      if (!file) return;
      const afterIdx = pendingInsertAfterIdx;
      pendingInsertAfterIdx = null;
      try {
        const key = 'src_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        await loadSource(key, file);
        const total = sources.get(key).pageCount;
        const selected = await promptInsertRange(file.name, total);
        if (selected === null) return;
        const newOps = selected.map(p => ({ sourceKey: key, pageIdx: p }));
        if (afterIdx === null || afterIdx === undefined) {
          operations.push(...newOps);
        } else {
          operations.splice(afterIdx + 1, 0, ...newOps);
        }
        renderList();
      } catch (err) {
        console.error(err);
        alert('Could not insert pages: ' + err.message);
      }
    });

    async function loadSource(key, file) {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      // pdf-lib (for assembly)
      const { PDFDocument } = PDFLib;
      const pdfLibDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });

      // pdf.js (for thumbnails)
      const pdfjsDoc = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise;

      sources.set(key, {
        name: file.name,
        bytes,
        pdfLibDoc,
        pdfjsDoc,
        pageCount: pdfLibDoc.getPageCount(),
      });
    }

    function renderList() {
      const list = $('pgList');
      list.innerHTML = '';

      for (let i = 0; i < operations.length; i++) {
        if (i === 0) {
          // Insert rail at very top
          list.appendChild(makeInsertRail(-1));
        }
        list.appendChild(makeRow(i));
        list.appendChild(makeInsertRail(i));
      }

      // Update stats
      $('pgStatsCount').textContent = operations.length;
      const delta = operations.length - originalCount;
      const fromOthers = operations.filter(op => op.sourceKey !== 'source').length;
      let deltaTxt = '';
      if (delta !== 0) deltaTxt += `${delta > 0 ? '+' : ''}${delta} from original`;
      if (fromOthers > 0) deltaTxt += (deltaTxt ? ' · ' : '') + `${fromOthers} inserted`;
      $('pgStatsDelta').textContent = deltaTxt;

      // Render thumbnails lazily
      requestAnimationFrame(() => renderThumbnails());
    }

    function makeRow(idx) {
      const op = operations[idx];
      const src = sources.get(op.sourceKey);
      const row = document.createElement('div');
      row.className = 'page-row';
      row.dataset.idx = idx;
      row.innerHTML = `
        <div class="drag-handle" aria-label="Drag to reorder">⋮⋮</div>
        <div class="page-thumb" data-thumb-key="${op.sourceKey}:${op.pageIdx}">
          <div class="page-thumb-loading"></div>
        </div>
        <div class="page-meta">
          <div class="page-meta-title">Page ${op.pageIdx + 1}</div>
          <div class="page-meta-sub" data-size-key="${op.sourceKey}:${op.pageIdx}">…</div>
          ${op.sourceKey !== 'source' ? `<div class="page-meta-source">from ${escapeHtml(src.name)}</div>` : ''}
        </div>
        <div class="page-actions">
          <button class="icon-btn danger" data-action="delete" aria-label="Delete page">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      `;

      // Delete button
      row.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
        e.stopPropagation();
        if (operations.length === 1) {
          alert('A PDF must have at least one page.');
          return;
        }
        operations.splice(idx, 1);
        renderList();
      });

      // Drag-to-reorder
      attachDragHandlers(row, idx);

      return row;
    }

    function makeInsertRail(afterIdx) {
      const rail = document.createElement('div');
      rail.className = 'insert-rail';
      rail.title = 'Insert page here';
      rail.addEventListener('click', () => {
        pendingInsertAfterIdx = afterIdx;
        $('pgInsertFile').click();
      });
      return rail;
    }

    // ----- Thumbnails (rendered via pdf.js) -----
    const thumbCache = new Map();  // key: "srcKey:pageIdx" → dataURL

    async function renderThumbnails() {
      const wraps = document.querySelectorAll('#pgList .page-thumb');
      for (const wrap of wraps) {
        const key = wrap.dataset.thumbKey;
        if (!key) continue;
        if (thumbCache.has(key)) {
          applyThumb(wrap, thumbCache.get(key), key);
          continue;
        }
        const [srcKey, idxStr] = key.split(':');
        const src = sources.get(srcKey);
        if (!src) continue;
        try {
          const pageNum = parseInt(idxStr, 10) + 1;
          const page = await src.pdfjsDoc.getPage(pageNum);
          const baseViewport = page.getViewport({ scale: 1 });
          const targetW = 120;  // CSS shows 60px, render 2x for crispness
          const scale = targetW / baseViewport.width;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const ctx = canvas.getContext('2d');
          await page.render({ canvasContext: ctx, viewport }).promise;
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          thumbCache.set(key, dataUrl);
          applyThumb(wrap, dataUrl, key);
          // Update size label too
          const sizeEl = document.querySelector(`[data-size-key="${key}"]`);
          if (sizeEl) {
            const pt = page.getViewport({ scale: 1 });
            sizeEl.textContent = `${Math.round(pt.width)} × ${Math.round(pt.height)} pt`;
          }
        } catch (err) {
          console.warn('Thumb render failed', err);
        }
      }
    }

    function applyThumb(wrap, dataUrl, key) {
      // Verify wrap still corresponds to this key (list may have re-rendered)
      if (wrap.dataset.thumbKey !== key) return;
      wrap.innerHTML = `<img src="${dataUrl}" alt="">`;
    }

    // ----- Drag-and-drop reorder -----

    function attachDragHandlers(row, idx) {
      const handle = row.querySelector('.drag-handle');
      let isDragging = false;
      let startY = 0;
      let allRows = [];
      let dropInsertIdx = idx;   // "if released now, insert moved item at this index"
      let pointerId = null;

      handle.addEventListener('pointerdown', onDown);

      function onDown(e) {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        pointerId = e.pointerId;
        handle.setPointerCapture(pointerId);
        isDragging = true;
        startY = e.clientY;
        allRows = Array.from(document.querySelectorAll('#pgList .page-row'));
        dropInsertIdx = idx;
        row.classList.add('dragging');
        document.body.style.cursor = 'grabbing';
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
      }

      function onMove(e) {
        if (!isDragging) return;
        const deltaY = e.clientY - startY;
        row.style.transform = `translateY(${deltaY}px) scale(1.02)`;

        // Compute insert position based on cursor's clientY against each other row's midpoint.
        // Pre-splice index: 0 = before all, allRows.length = after all.
        let target = 0;
        for (const r of allRows) {
          if (r === row) continue;
          const rRect = r.getBoundingClientRect();
          const rMid = rRect.top + rRect.height / 2;
          if (e.clientY > rMid) target++;
        }
        // Adjust so target represents the final index after removing the dragged row first.
        // We compute against pre-splice ordering: if target > idx, after splice it shifts -1.
        dropInsertIdx = target;
      }

      function onUp() {
        if (!isDragging) return;
        isDragging = false;
        row.style.transform = '';
        row.classList.remove('dragging');
        document.body.style.cursor = '';
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        try { handle.releasePointerCapture(pointerId); } catch (_) {}

        let finalIdx = dropInsertIdx;
        if (finalIdx > idx) finalIdx -= 1;  // account for splice-out
        if (finalIdx !== idx && finalIdx >= 0 && finalIdx <= operations.length - 1) {
          const [moved] = operations.splice(idx, 1);
          operations.splice(finalIdx, 0, moved);
          renderList();
        }
      }
    }

    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, c =>
        ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    // Cancel / Save
    $('btnPgCancel').addEventListener('click', () => {
      reset();
      setScreen('pg', 'Select');
    });

    function setProg(pct, status) {
      setRing($('pgProgressCircle'), $('pgProgressPct'), $('pgProgressStatus'), pct, status);
    }

    $('btnPgSave').addEventListener('click', async () => {
      if (operations.length === 0) {
        showError('pgError', 'Cannot save an empty PDF.');
        return;
      }
      hideError('pgError');
      setScreen('pg', 'Progress');
      setProg(5, 'Preparing…');

      try {
        const { PDFDocument } = PDFLib;
        const outDoc = await PDFDocument.create();

        const total = operations.length;
        // Group ops by source for batched copyPages
        for (let i = 0; i < total; i++) {
          const op = operations[i];
          const src = sources.get(op.sourceKey);
          const [page] = await outDoc.copyPages(src.pdfLibDoc, [op.pageIdx]);
          outDoc.addPage(page);
          setProg(5 + (i / total) * 85, `Adding page ${i + 1} of ${total}…`);
        }

        setProg(92, 'Saving…');
        const savedBytes = await outDoc.save({ useObjectStreams: true });
        outputBytes = savedBytes;

        const baseName = sourceFile.name.replace(/\.pdf$/i, '');
        outputFileName = baseName + '_edited.pdf';

        $('pgResPages').textContent = operations.length;
        $('pgResSize').textContent = formatSize(savedBytes.length);

        setProg(100, 'Done!');
        await new Promise(r => setTimeout(r, 300));
        setScreen('pg', 'Result');
      } catch (err) {
        console.error(err);
        setScreen('pg', 'Editor');
        showError('pgError', 'Save failed: ' + (err.message || 'Unknown error'));
      }
    });

    $('btnPgDownload').addEventListener('click', () => {
      if (outputBytes) downloadBlob(outputBytes, outputFileName);
    });
    $('btnPgShare').addEventListener('click', async () => {
      if (outputBytes) {
        try { await shareFile(outputBytes, outputFileName); }
        catch (err) { /* ignore */ }
      }
    });
    $('btnPgAgain').addEventListener('click', () => {
      reset();
      setScreen('pg', 'Select');
    });

    function reset() {
      sourceFile = null;
      sources.clear();
      operations = [];
      originalCount = 0;
      outputBytes = null;
      outputFileName = '';
      thumbCache.clear();
      $('pgFile').value = '';
      $('pgList').innerHTML = '';
    }
  })();

  // ---------------------------------------------------------------------------
  // Merge tab
  // ---------------------------------------------------------------------------

  const merge = (() => {
    let files = [];   // { file, size, pdfLibDoc }
    let outputBytes = null;
    let outputFileName = 'merged.pdf';

    $('btnMgSelect').addEventListener('click', () => $('mgFiles').click());
    $('btnMgAdd').addEventListener('click', () => $('mgFiles').click());

    $('mgFiles').addEventListener('change', async (e) => {
      const list = Array.from(e.target.files);
      $('mgFiles').value = '';
      if (list.length === 0) return;
      for (const file of list) {
        if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') continue;
        try {
          const buf = await file.arrayBuffer();
          const bytes = new Uint8Array(buf);
          const { PDFDocument } = PDFLib;
          const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
          files.push({ name: file.name, size: file.size, bytes, pdfLibDoc: doc });
        } catch (err) {
          console.warn('Skipped', file.name, err);
        }
      }
      if (files.length === 0) {
        showError('mgError', 'No valid PDFs selected.');
        return;
      }
      hideError('mgError');
      setScreen('mg', 'List');
      renderRows();
    });

    function renderRows() {
      const wrap = $('mgRows');
      wrap.innerHTML = '';
      let totalBytes = 0;
      files.forEach((f, idx) => {
        totalBytes += f.size;
        const row = document.createElement('div');
        row.className = 'merge-row';
        row.dataset.idx = idx;
        row.innerHTML = `
          <div class="drag-handle">⋮⋮</div>
          <div class="merge-row-icon">
            <svg fill="none" viewBox="0 0 24 24" stroke="#00b4d8" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </div>
          <div class="merge-row-meta">
            <div class="merge-row-name">${escapeHtml(f.name)}</div>
            <div class="merge-row-size">${formatSize(f.size)} · ${f.pdfLibDoc.getPageCount()} pages</div>
          </div>
          <div class="page-actions">
            <button class="icon-btn danger" data-action="delete" aria-label="Remove file">
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        `;
        row.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
          e.stopPropagation();
          files.splice(idx, 1);
          if (files.length === 0) {
            setScreen('mg', 'Select');
          } else {
            renderRows();
          }
        });
        attachMergeDrag(row, idx);
        wrap.appendChild(row);
      });
      $('mgStatsCount').textContent = files.length;
      $('mgStatsSize').textContent = formatSize(totalBytes);
    }

    function attachMergeDrag(row, idx) {
      const handle = row.querySelector('.drag-handle');
      let pointerId = null;
      let isDragging = false;
      let startY = 0;
      let allRows = [];
      let dropInsertIdx = idx;

      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        pointerId = e.pointerId;
        handle.setPointerCapture(pointerId);
        isDragging = true;
        startY = e.clientY;
        allRows = Array.from(document.querySelectorAll('#mgRows .merge-row'));
        dropInsertIdx = idx;
        row.classList.add('dragging');
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
      });

      function onMove(e) {
        if (!isDragging) return;
        const dy = e.clientY - startY;
        row.style.transform = `translateY(${dy}px) scale(1.02)`;
        let target = 0;
        for (const r of allRows) {
          if (r === row) continue;
          const rRect = r.getBoundingClientRect();
          const rMid = rRect.top + rRect.height / 2;
          if (e.clientY > rMid) target++;
        }
        dropInsertIdx = target;
      }
      function onUp() {
        if (!isDragging) return;
        isDragging = false;
        row.style.transform = '';
        row.classList.remove('dragging');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        try { handle.releasePointerCapture(pointerId); } catch (_) {}

        let finalIdx = dropInsertIdx;
        if (finalIdx > idx) finalIdx -= 1;
        if (finalIdx !== idx && finalIdx >= 0 && finalIdx <= files.length - 1) {
          const [moved] = files.splice(idx, 1);
          files.splice(finalIdx, 0, moved);
          renderRows();
        }
      }
    }

    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, c =>
        ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    function setProg(pct, status) {
      setRing($('mgProgressCircle'), $('mgProgressPct'), $('mgProgressStatus'), pct, status);
    }

    $('btnMgClear').addEventListener('click', () => {
      files = []; outputBytes = null;
      $('mgRows').innerHTML = '';
      setScreen('mg', 'Select');
    });

    $('btnMgRun').addEventListener('click', async () => {
      if (files.length === 0) return;
      hideError('mgError');
      setScreen('mg', 'Progress');
      setProg(5, 'Preparing…');

      try {
        const { PDFDocument } = PDFLib;
        const outDoc = await PDFDocument.create();
        const total = files.length;
        for (let i = 0; i < total; i++) {
          const f = files[i];
          const pageIdxs = f.pdfLibDoc.getPageIndices();
          const copied = await outDoc.copyPages(f.pdfLibDoc, pageIdxs);
          copied.forEach(p => outDoc.addPage(p));
          setProg(5 + (i + 1) / total * 85, `Merging ${i + 1} of ${total}…`);
        }
        setProg(92, 'Saving…');
        const saved = await outDoc.save({ useObjectStreams: true });
        outputBytes = saved;
        outputFileName = 'merged_' + new Date().toISOString().slice(0, 10) + '.pdf';

        $('mgResCount').textContent = files.length;
        $('mgResSize').textContent = formatSize(saved.length);

        setProg(100, 'Done!');
        await new Promise(r => setTimeout(r, 300));
        setScreen('mg', 'Result');
      } catch (err) {
        console.error(err);
        setScreen('mg', 'List');
        showError('mgError', 'Merge failed: ' + (err.message || 'Unknown error'));
      }
    });

    $('btnMgDownload').addEventListener('click', () => {
      if (outputBytes) downloadBlob(outputBytes, outputFileName);
    });
    $('btnMgShare').addEventListener('click', async () => {
      if (outputBytes) {
        try { await shareFile(outputBytes, outputFileName); } catch (_) {}
      }
    });
    $('btnMgAgain').addEventListener('click', () => {
      files = []; outputBytes = null;
      $('mgRows').innerHTML = '';
      setScreen('mg', 'Select');
    });
  })();

  // ---------------------------------------------------------------------------
  // Split tab — extract pages or split-every-page (zip)
  // ---------------------------------------------------------------------------

  const split = (() => {
    let selectedFile = null;
    let selectedBytes = null;
    let sourceDoc = null;
    let totalPages = 0;
    let mode = 'extract';
    let outputBytes = null;
    let outputFileName = '';
    let outputMime = 'application/pdf';
    let outputCount = 0;

    $('btnSpSelect').addEventListener('click', () => $('spFile').click());
    $('btnSpChange').addEventListener('click', () => { $('spFile').value = ''; $('spFile').click(); });

    $('spFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        alert('Please select a PDF file.');
        return;
      }
      selectedFile = file;
      try {
        const buf = await file.arrayBuffer();
        selectedBytes = new Uint8Array(buf);
        const { PDFDocument } = PDFLib;
        sourceDoc = await PDFDocument.load(selectedBytes, { ignoreEncryption: true });
        totalPages = sourceDoc.getPageCount();
      } catch (err) {
        alert('Could not open PDF: ' + err.message);
        return;
      }
      $('spFileName').textContent = file.name;
      $('spFileSize').textContent = `${formatSize(file.size)} · ${totalPages} pages`;
      $('spRange').placeholder = totalPages > 1 ? `1-${totalPages}` : '1';
      hideError('spError');
      setScreen('sp', 'Config');
    });

    document.querySelectorAll('#spMode .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#spMode .seg-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        mode = btn.dataset.mode;
        $('spRangeWrap').style.display = mode === 'extract' ? 'block' : 'none';
      });
    });

    function setProg(pct, status) {
      setRing($('spProgressCircle'), $('spProgressPct'), $('spProgressStatus'), pct, status);
    }

    $('btnSpRun').addEventListener('click', async () => {
      if (!sourceDoc) return;
      hideError('spError');

      try {
        if (mode === 'extract') {
          const raw = $('spRange').value.trim();
          if (!raw) { showError('spError', 'Enter page numbers to extract.'); return; }
          let pages;
          try { pages = parseRanges(raw, totalPages); }
          catch (err) { showError('spError', err.message); return; }
          if (pages.length === 0) { showError('spError', 'No valid pages.'); return; }

          setScreen('sp', 'Progress');
          setProg(10, 'Extracting…');

          const { PDFDocument } = PDFLib;
          const out = await PDFDocument.create();
          for (let i = 0; i < pages.length; i++) {
            const [p] = await out.copyPages(sourceDoc, [pages[i]]);
            out.addPage(p);
            setProg(10 + (i / pages.length) * 80, `Page ${i + 1} of ${pages.length}…`);
          }
          setProg(92, 'Saving…');
          const saved = await out.save({ useObjectStreams: true });
          outputBytes = saved;
          outputMime = 'application/pdf';
          outputCount = 1;

          const base = selectedFile.name.replace(/\.pdf$/i, '');
          outputFileName = base + '_extracted.pdf';

          $('spResCount').textContent = '1 PDF';
          $('spResSize').textContent = formatSize(saved.length);
          $('spDownloadLabel').textContent = 'Save to Files';
        } else {
          // Every page → ZIP
          setScreen('sp', 'Progress');
          setProg(5, 'Splitting…');

          const { PDFDocument } = PDFLib;
          const zip = new JSZip();
          const base = selectedFile.name.replace(/\.pdf$/i, '');
          for (let i = 0; i < totalPages; i++) {
            const single = await PDFDocument.create();
            const [p] = await single.copyPages(sourceDoc, [i]);
            single.addPage(p);
            const bytes = await single.save();
            const pageNum = String(i + 1).padStart(3, '0');
            zip.file(`${base}_page_${pageNum}.pdf`, bytes);
            setProg(5 + (i + 1) / totalPages * 85, `Page ${i + 1} of ${totalPages}…`);
          }
          setProg(92, 'Zipping…');
          const zipBlob = await zip.generateAsync({ type: 'uint8array' });
          outputBytes = zipBlob;
          outputMime = 'application/zip';
          outputCount = totalPages;
          outputFileName = base + '_split.zip';

          $('spResCount').textContent = totalPages + ' PDFs';
          $('spResSize').textContent = formatSize(zipBlob.length);
          $('spDownloadLabel').textContent = 'Save ZIP';
        }

        setProg(100, 'Done!');
        await new Promise(r => setTimeout(r, 300));
        setScreen('sp', 'Result');
      } catch (err) {
        console.error(err);
        setScreen('sp', 'Config');
        showError('spError', 'Split failed: ' + (err.message || 'Unknown error'));
      }
    });

    $('btnSpDownload').addEventListener('click', () => {
      if (outputBytes) downloadBlob(outputBytes, outputFileName, outputMime);
    });
    $('btnSpShare').addEventListener('click', async () => {
      if (outputBytes) {
        try { await shareFile(outputBytes, outputFileName, outputMime); } catch (_) {}
      }
    });
    $('btnSpAgain').addEventListener('click', () => {
      selectedFile = null; selectedBytes = null; sourceDoc = null;
      totalPages = 0; outputBytes = null;
      $('spFile').value = ''; $('spRange').value = '';
      setScreen('sp', 'Select');
    });
  })();

  // ---------------------------------------------------------------------------
  // Redact tab — true text removal via mupdf.js (MuPDF compiled to WASM)
  // ---------------------------------------------------------------------------

  // Lazy-load mupdf.js (~10MB WASM payload) on demand.
  let mupdfReady = null;
  function ensureMupdf() {
    if (mupdfReady) return mupdfReady;
    mupdfReady = (async () => {
      // mupdf is an ESM package — dynamic import works for module CDN URLs.
      // jsdelivr resolves the package.json "module" field correctly for us.
      const mod = await import('https://cdn.jsdelivr.net/npm/mupdf@1.3.5/dist/mupdf.js');
      return mod;
    })();
    return mupdfReady;
  }

  const redact = (() => {
    let selectedFile = null;
    let sourceBytes = null;
    let mupdf = null;          // loaded module
    let pdfDoc = null;         // mupdfjs.PDFDocument
    let pageCount = 0;
    let selectedColor = 'black';
    let outputBytes = null;
    let outputFileName = '';

    $('btnRdSelect').addEventListener('click', () => $('rdFile').click());
    $('btnRdChange').addEventListener('click', () => { $('rdFile').value = ''; $('rdFile').click(); });

    $('rdFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        alert('Please select a PDF file.');
        return;
      }
      selectedFile = file;

      // Load mupdf if not yet loaded
      if (!mupdf) {
        setScreen('rd', 'Loading');
        $('rdLoadingStatus').textContent = 'Downloading redaction engine…';
        try {
          mupdf = await ensureMupdf();
          $('rdLoadingStatus').textContent = 'Parsing PDF…';
        } catch (err) {
          console.error(err);
          setScreen('rd', 'Select');
          alert('Could not load redaction engine: ' + err.message
            + '\n\nCheck your network connection and try again.');
          return;
        }
      }

      // Parse the PDF
      try {
        const buf = await file.arrayBuffer();
        sourceBytes = new Uint8Array(buf);
        pdfDoc = mupdf.PDFDocument.openDocument(sourceBytes, 'application/pdf');
        pageCount = pdfDoc.countPages();
      } catch (err) {
        console.error(err);
        setScreen('rd', 'Select');
        alert('Could not open PDF: ' + err.message);
        return;
      }

      $('rdFileName').textContent = file.name;
      $('rdFileSize').textContent = `${formatSize(file.size)} · ${pageCount} page${pageCount !== 1 ? 's' : ''}`;
      $('rdMatches').style.display = 'none';
      $('rdTerms').value = '';
      hideError('rdError');
      setScreen('rd', 'Config');
    });

    // Color swatch picker
    document.querySelectorAll('#rdColor .color-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        document.querySelectorAll('#rdColor .color-swatch').forEach(s => s.classList.remove('selected'));
        sw.classList.add('selected');
        selectedColor = sw.dataset.color;
      });
    });

    function getTerms() {
      return $('rdTerms').value
        .split('\n')
        .map(t => t.trim())
        .filter(t => t.length > 0);
    }

    // Find matches (returns Map<term, [{pageIdx, quads}]>)
    function findMatches(doc, terms) {
      const matches = new Map();
      for (const term of terms) matches.set(term, []);

      const total = doc.countPages();
      for (let i = 0; i < total; i++) {
        const page = doc.loadPage(i);
        try {
          for (const term of terms) {
            try {
              const hits = page.search(term, 500);
              if (hits && hits.length) {
                for (const hit of hits) {
                  matches.get(term).push({ pageIdx: i, quads: hit });
                }
              }
            } catch (_) { /* skip term */ }
          }
        } finally {
          if (page.destroy) page.destroy();
        }
      }
      return matches;
    }

    $('btnRdPreview').addEventListener('click', () => {
      const terms = getTerms();
      if (!terms.length) { showError('rdError', 'Enter at least one term.'); return; }
      if (!pdfDoc) return;
      hideError('rdError');

      try {
        const matches = findMatches(pdfDoc, terms);
        const list = $('rdMatches');
        list.innerHTML = '';
        let total = 0;
        for (const term of terms) {
          const count = matches.get(term).length;
          total += count;
          const row = document.createElement('div');
          row.className = 'match-row' + (count === 0 ? ' zero' : '');
          row.innerHTML = `<span class="term">${escapeHtml(term)}</span><span class="count">${count}</span>`;
          list.appendChild(row);
        }
        const totalRow = document.createElement('div');
        totalRow.className = 'match-row';
        totalRow.style.borderTop = '1px solid rgba(255,255,255,0.06)';
        totalRow.style.paddingTop = '6px';
        totalRow.style.marginTop = '2px';
        totalRow.innerHTML = `<span class="term" style="color:var(--text-dim)">Total</span><span class="count">${total}</span>`;
        list.appendChild(totalRow);
        list.style.display = 'flex';
      } catch (err) {
        console.error(err);
        showError('rdError', 'Preview failed: ' + err.message);
      }
    });

    function setProg(pct, status) {
      setRing($('rdProgressCircle'), $('rdProgressPct'), $('rdProgressStatus'), pct, status);
    }

    $('btnRdRun').addEventListener('click', async () => {
      const terms = getTerms();
      if (!terms.length) { showError('rdError', 'Enter at least one term.'); return; }
      if (!pdfDoc || !mupdf) return;
      hideError('rdError');

      setScreen('rd', 'Progress');
      setProg(5, 'Finding matches…');

      try {
        // Re-open the doc fresh so we can apply destructive redactions without
        // worrying about the preview-pass state.
        const doc = mupdf.PDFDocument.openDocument(sourceBytes, 'application/pdf');
        const total = doc.countPages();
        const fillColor = selectedColor === 'white' ? [1, 1, 1] : [0, 0, 0];
        let totalMatches = 0;

        for (let i = 0; i < total; i++) {
          const page = doc.loadPage(i);
          try {
            let pageHasMatch = false;
            for (const term of terms) {
              let hits;
              try { hits = page.search(term, 500); } catch (_) { continue; }
              if (!hits || !hits.length) continue;
              for (const hit of hits) {
                // hit is an array of quads (one per line of wrapped text)
                for (const quad of hit) {
                  const rect = quadToRect(quad);
                  try {
                    const annot = page.addRedactionAnnotation
                      ? page.addRedactionAnnotation(rect)
                      : (page.createAnnotation
                          ? page.createAnnotation('Redact')
                          : null);
                    if (annot) {
                      if (annot.setRect) annot.setRect(rect);
                      if (annot.setColor) annot.setColor(fillColor);
                      if (annot.setInteriorColor) annot.setInteriorColor(fillColor);
                    }
                    totalMatches++;
                    pageHasMatch = true;
                  } catch (e) {
                    console.warn('addRedactionAnnotation failed', e);
                  }
                }
              }
            }
            if (pageHasMatch) {
              // Apply redactions on this page — true text removal
              try {
                page.applyRedactions(selectedColor !== 'white', 0, 0);
              } catch (e) {
                // Fallback signature
                try { page.applyRedactions(); } catch (e2) { console.warn('applyRedactions failed', e2); }
              }
            }
            setProg(5 + (i + 1) / total * 85, `Page ${i + 1} of ${total}…`);
          } finally {
            if (page.destroy) page.destroy();
          }
        }

        setProg(92, 'Saving…');
        const buf = doc.saveToBuffer ? doc.saveToBuffer('') : doc.save();
        const savedBytes = buf.asUint8Array ? buf.asUint8Array() : new Uint8Array(buf);
        outputBytes = savedBytes;
        if (doc.destroy) doc.destroy();

        const base = selectedFile.name.replace(/\.pdf$/i, '');
        outputFileName = base + '_redacted.pdf';

        $('rdResMatches').textContent = totalMatches;
        $('rdResSize').textContent = formatSize(savedBytes.length);

        setProg(100, 'Done!');
        await new Promise(r => setTimeout(r, 300));
        setScreen('rd', 'Result');
      } catch (err) {
        console.error(err);
        setScreen('rd', 'Config');
        showError('rdError', 'Redaction failed: ' + (err.message || 'Unknown error'));
      }
    });

    function quadToRect(q) {
      // mupdf quads may be returned as objects with ul/ur/ll/lr points,
      // or as 8-element arrays [ulx, uly, urx, ury, llx, lly, lrx, lry].
      if (q && q.ul && q.lr) {
        return [
          Math.min(q.ul.x, q.ll.x),
          Math.min(q.ul.y, q.ur.y),
          Math.max(q.ur.x, q.lr.x),
          Math.max(q.ll.y, q.lr.y),
        ];
      }
      if (Array.isArray(q) && q.length === 8) {
        const xs = [q[0], q[2], q[4], q[6]];
        const ys = [q[1], q[3], q[5], q[7]];
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      }
      // Already a rect [x0,y0,x1,y1]?
      if (Array.isArray(q) && q.length === 4) return q;
      // Last resort
      return [0, 0, 0, 0];
    }

    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, c =>
        ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    $('btnRdDownload').addEventListener('click', () => {
      if (outputBytes) downloadBlob(outputBytes, outputFileName);
    });
    $('btnRdShare').addEventListener('click', async () => {
      if (outputBytes) {
        try { await shareFile(outputBytes, outputFileName); } catch (_) {}
      }
    });
    $('btnRdAgain').addEventListener('click', () => {
      if (pdfDoc && pdfDoc.destroy) pdfDoc.destroy();
      selectedFile = null; sourceBytes = null; pdfDoc = null;
      pageCount = 0; outputBytes = null;
      $('rdFile').value = '';
      $('rdTerms').value = '';
      $('rdMatches').style.display = 'none';
      setScreen('rd', 'Select');
    });
  })();

  // ---------------------------------------------------------------------------
  // Unlock tab
  // ---------------------------------------------------------------------------

  const unlock = (() => {
    let outputBytes = null;
    let outputFileName = '';

    $('btnUlSelect').addEventListener('click', () => $('ulFile').click());

    $('ulFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        alert('Please select a PDF file.');
        return;
      }

      setScreen('ul', 'Progress');
      setRing($('ulProgressCircle'), $('ulProgressPct'), $('ulProgressStatus'), 20, 'Reading file…');

      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const { PDFDocument } = PDFLib;

        setRing($('ulProgressCircle'), $('ulProgressPct'), $('ulProgressStatus'), 50, 'Removing restrictions…');

        // ignoreEncryption: true handles owner-password-restricted PDFs (the common case).
        // PDFs encrypted with a user password require true decryption, which pdf-lib does not support.
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });

        setRing($('ulProgressCircle'), $('ulProgressPct'), $('ulProgressStatus'), 80, 'Saving unlocked PDF…');

        doc.setProducer('');
        doc.setCreator('');

        const saved = await doc.save({ useObjectStreams: true });
        outputBytes = saved;
        const base = file.name.replace(/\.pdf$/i, '');
        outputFileName = base + '_unlocked.pdf';

        $('ulResName').textContent = outputFileName;
        $('ulResStatus').textContent = 'Restrictions removed · ' + formatSize(saved.length);

        setRing($('ulProgressCircle'), $('ulProgressPct'), $('ulProgressStatus'), 100, 'Done!');
        await new Promise(r => setTimeout(r, 300));
        hideError('ulError');
        setScreen('ul', 'Result');
      } catch (err) {
        console.error(err);
        setScreen('ul', 'Select');
        const msg = /password/i.test(err.message || '')
          ? 'This PDF is encrypted with a user password and cannot be unlocked in the browser.'
          : 'Unlock failed: ' + (err.message || 'Unknown error');
        alert(msg);
      }
    });

    $('btnUlDownload').addEventListener('click', () => {
      if (outputBytes) downloadBlob(outputBytes, outputFileName);
    });
    $('btnUlShare').addEventListener('click', async () => {
      if (outputBytes) {
        try { await shareFile(outputBytes, outputFileName); } catch (_) {}
      }
    });
    $('btnUlAgain').addEventListener('click', () => {
      outputBytes = null;
      $('ulFile').value = '';
      setScreen('ul', 'Select');
    });
  })();

})();
