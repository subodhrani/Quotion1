/*
 * pdf-import.js
 * Quotation PDF ko parse karke form fields + items table data nikalta hai.
 * Is app se bani PDF (Get Quotation -> Save as PDF) ke layout ke liye tune kiya gaya hai.
 * Depends on: pdf.min.js (pdfjsLib)
 */
(function () {
  'use strict';

  var FIELD_LABELS = {
    FROMADDRESS: 'fromAddress',
    INVOICETO: 'invoiceTo',
    OTHERDETAILS: 'otherDetails',
    INTROTEXT: 'introText',
    'F.O.R.': 'forValue',
    FOR: 'forValue',
    CGST: 'cgstValue',
    IGST: 'igstValue',
    'CARTAGE/PAYMENT': 'cartageValue',
    DISPATCH: 'dispatchText',
    TERMSINSTRUCTION: 'termsText',
    PREPAREDBY: 'preparedBy'
  };
  var SINGLE_LINE = { forValue: 1, cgstValue: 1, igstValue: 1, cartageValue: 1, preparedBy: 1 };
    var LINE_TOL = 3;

  function normLabel(s) {
    return String(s).toUpperCase().replace(/\s+/g, '');
  }

  var HEADER_RES = [
    ['sno', /^S\.?NO\.?$/],
    ['make', /^MAKE$/],
    ['itemName', /^ITEM(NAME)?$/],
    ['quantity', /^(QUANTITY|QTY)$/],
    ['units', /^UNITS?$/],
    ['hsn', /^(HSN\/?CODE|HSN|CODE)$/],
    ['rate', /^RATE/],
    ['value', /^(VALUE|AMOUNT)/]
  ];

  function headerKey(text) {
    var n = normLabel(text);
    for (var i = 0; i < HEADER_RES.length; i++) {
      if (HEADER_RES[i][1].test(n)) return HEADER_RES[i][0];
    }
    return null;
  }

  function loadScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-src="' + src + '"]')) return resolve();
      var el = document.createElement('script');
      el.src = src;
      el.dataset.src = src;
      el.onload = resolve;
      el.onerror = function () { reject(new Error('Script load nahi hui: ' + src)); };
      document.head.appendChild(el);
    });
  }

  function abs(path) { return new URL(path, document.baseURI).href; }

  var OCR_DPI = 300;
  var OCR_SCALE = OCR_DPI / 72;
  var HF_MARGIN = 22; // browser header/footer (date, URL, page no.) ko ignore karne ke liye

  // OCR ke words ko phrases (items) me jodta hai: chhota gap = same phrase, bada gap = alag column.
  function ocrLinesToItems(lines, yOff, pageH) {
    var out = [];
    lines.forEach(function (ln) {
      var words = (ln.words || []).filter(function (w) { return w.text && w.text.trim(); })
        .sort(function (a, b) { return a.bbox.x0 - b.bbox.x0; });
      if (!words.length) return;
      var midY = (ln.bbox.y0 + ln.bbox.y1) / 2 / OCR_SCALE;
      var cur = null;
      words.forEach(function (w) {
        var x0 = w.bbox.x0 / OCR_SCALE, x1 = w.bbox.x1 / OCR_SCALE;
        var h = (w.bbox.y1 - w.bbox.y0) / OCR_SCALE;
        if (cur && x0 - (cur.x + cur.w) < Math.max(h, 6) * 0.9) {
          cur.s += ' ' + w.text.trim();
          cur.w = x1 - cur.x;
        } else {
          if (cur) out.push(cur);
          cur = { s: w.text.trim(), x: x0, w: x1 - x0, y: yOff + midY, py: midY, ph: pageH };
        }
      });
      if (cur) out.push(cur);
    });
    return out;
  }

  async function ocrPages(pdf, progress) {
    await loadScriptOnce('./tesseract.min.js');
    var worker = await Tesseract.createWorker('eng', 1, {
      workerPath: abs('./tesseract-worker.min.js'),
      corePath: abs('./').replace(/\/$/, ''),
      langPath: abs('./').replace(/\/$/, ''),
      gzip: true,
      logger: function (m) {
        if (m.status === 'recognizing text' && progress) progress(m.progress);
      }
    });
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    var items = [];
    var yOff = 0;
    var pageWidth = 595;
    try {
      for (var p = 1; p <= pdf.numPages; p++) {
        if (progress) progress(0, p, pdf.numPages);
        var page = await pdf.getPage(p);
        var vp = page.getViewport({ scale: OCR_SCALE });
        var canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        var res = await worker.recognize(canvas);
        var pageH = vp.height / OCR_SCALE;
        pageWidth = vp.width / OCR_SCALE;
        items = items.concat(ocrLinesToItems(res.data.lines || [], yOff, pageH));
        canvas.width = canvas.height = 0;
        yOff += pageH + 200;
      }
    } finally {
      await worker.terminate();
    }
    return { items: items, pageWidth: pageWidth };
  }

  async function extractItems(buffer, progress) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = abs('./pdf.worker.min.js');
    var pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    var items = [];
    var yOff = 0;
    var pageWidth = 595;
    for (var p = 1; p <= pdf.numPages; p++) {
      var page = await pdf.getPage(p);
      var vp = page.getViewport({ scale: 1 });
      pageWidth = vp.width;
      var tc = await page.getTextContent();
      tc.items.forEach(function (it) {
        if (!it.str || !it.str.trim()) return;
        var py = vp.height - it.transform[5];
        items.push({ s: it.str, x: it.transform[4], y: yOff + py, py: py, ph: vp.height, w: it.width });
      });
      yOff += vp.height + 200;
    }
    var chars = items.reduce(function (n, it) { return n + it.s.trim().length; }, 0);
    var mode = 'text';
    if (chars < 20) {
      // Text layer nahi hai (jaise "Microsoft Print to PDF") -> OCR
      var o = await ocrPages(pdf, progress);
      items = o.items;
      pageWidth = o.pageWidth;
      mode = 'ocr';
    }
    items = items.filter(function (it) { return it.py >= HF_MARGIN && it.py <= it.ph - HF_MARGIN; });
    return { items: items, pageWidth: pageWidth, numPages: pdf.numPages, mode: mode };
  }

  function groupLines(items) {
    var sorted = items.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    var lines = [];
    sorted.forEach(function (it) {
      var last = lines[lines.length - 1];
      if (last && Math.abs(it.y - last.y) <= LINE_TOL) {
        last.items.push(it);
      } else {
        lines.push({ y: it.y, items: [it] });
      }
    });
    lines.forEach(function (l) { l.items.sort(function (a, b) { return a.x - b.x; }); });
    return lines;
  }

  function joinItems(its) {
    var out = '';
    var prev = null;
    its.forEach(function (it) {
      if (prev) {
        var gap = it.x - (prev.x + prev.w);
        var needSpace = gap > 1 && !/\s$/.test(out) && !/^\s/.test(it.s);
        out += (needSpace ? ' ' : '') + it.s;
      } else {
        out += it.s;
      }
      prev = it;
    });
    return out.trim();
  }

  function lineEnd(line) {
    var last = line.items[line.items.length - 1];
    return last.x + last.w;
  }

  // Lines ko text me jodta hai. Agar line wrap hui hai (next word line ke end me fit nahi hota) to space se jodta hai.
  function joinLines(lines, left, containerRight, forceSpace) {
    var out = '';
    lines.forEach(function (ln, i) {
      var text = joinItems(ln.items);
      if (i === 0) { out = text; return; }
      if (forceSpace) { out += ' ' + text; return; }
      var prev = lines[i - 1];
      var prevText = joinItems(prev.items);
      var start = prev.items[0].x;
      var width = lineEnd(prev) - start;
      var avg = prevText.length ? width / prevText.length : 4;
      var firstWord = (text.split(/\s+/)[0] || '').length * avg;
      var room = containerRight - lineEnd(prev);
      var wrapped = room < firstWord + avg * 1.5;
      out += (wrapped ? ' ' : '\n') + text;
    });
    return out;
  }

  function parse(extracted) {
    var items = extracted.items;
    var pageWidth = extracted.pageWidth;
    var warnings = [];
    if (!items.length) {
      throw new Error('PDF me text nahi mila (shayad scanned/image PDF hai).');
    }
    var lines = groupLines(items);

    // --- labels ---
    var labels = [];
    var seen = {};
    items.forEach(function (it) {
      var id = FIELD_LABELS[normLabel(it.s)];
      if (id && !seen[id]) {
        seen[id] = true;
        labels.push({ id: id, x: it.x, y: it.y, item: it });
      }
    });

    // --- table header ---
    var headerLine = null;
    for (var i = 0; i < lines.length; i++) {
      var hits = lines[i].items.filter(function (it) { return headerKey(it.s); });
      if (hits.length >= 3) { headerLine = lines[i]; break; }
    }

    var itemsCountLine = null;
    lines.forEach(function (ln) {
      if (!itemsCountLine && ln.items.some(function (it) { return /^items\s*count$/i.test(it.s.trim()); })) {
        itemsCountLine = ln;
      }
    });

    var forLabel = labels.filter(function (l) { return l.id === 'forValue' || l.id === 'cgstValue' || l.id === 'igstValue' || l.id === 'cartageValue'; })
      .sort(function (a, b) { return a.y - b.y; })[0];

    var tableStart = headerLine ? headerLine.y - 1 : null;
    var tableEnd = null;
    if (forLabel) tableEnd = forLabel.y - 2;
    else if (itemsCountLine) tableEnd = itemsCountLine.y + 40;

    // --- label regions ---
    labels.forEach(function (l) {
      var rb = Infinity;
      labels.forEach(function (m) {
        if (m !== l && Math.abs(m.y - l.y) < LINE_TOL && m.x > l.x + 5 && m.x - 1 < rb) rb = m.x - 1;
      });
      l.rb = rb;
    });

    function inTable(it) {
      return tableStart !== null && tableEnd !== null && it.y >= tableStart && it.y <= tableEnd;
    }

    var labelItems = labels.map(function (l) { return l.item; });
    var blocks = {};
    items.forEach(function (it) {
      if (labelItems.indexOf(it) !== -1) return;
      if (inTable(it)) return;
      if (/^(quotation|quatation|quotaion)$/i.test(it.s.trim())) return;
      var best = null;
      labels.forEach(function (l) {
        if (l.y < it.y - 1 && it.x >= l.x - 3 && it.x < l.rb) {
          if (!best || l.y > best.y || (l.y === best.y && l.x > best.x)) best = l;
        }
      });
      if (best) (blocks[best.id] = blocks[best.id] || []).push(it);
    });

    var contentRight = items.reduce(function (m, it) { return Math.max(m, it.x + it.w); }, 0);
    var fields = {};
    labels.forEach(function (l) {
      var its = blocks[l.id] || [];
      var ls = groupLines(its);
      var right = l.rb === Infinity ? contentRight : l.rb - 9;
      fields[l.id] = ls.length ? joinLines(ls, l.x, right, !!SINGLE_LINE[l.id]) : '';
    });

    // --- table ---
    var columns = [];
    var rows = [];
    if (headerLine && tableEnd !== null) {
      var hItems = headerLine.items;
      var tol = 4;
      var colX = hItems.map(function (h) { return h.x; });
      columns = hItems.map(function (h) { return { label: h.s.trim(), key: headerKey(h.s) }; });

      var colIndex = function (it) {
        var idx = 0;
        for (var c = 0; c < colX.length; c++) {
          if (it.x >= colX[c] - tol) idx = c;
        }
        return idx;
      };

      var bodyLines = lines.filter(function (ln) {
        if (ln.y <= headerLine.y + 1) return false;
        if (ln.y > tableEnd) return false;
        if (itemsCountLine && ln.y >= itemsCountLine.y - 1) return false;
        // page break pe repeat hua header skip karo
        var hh = ln.items.filter(function (it) { return headerKey(it.s); });
        if (hh.length >= 3) return false;
        return true;
      });

      var firstColUsed = bodyLines.some(function (ln) {
        return ln.items.some(function (it) { return colIndex(it) === 0; });
      });

      var cur = null;
      bodyLines.forEach(function (ln) {
        var cells = {};
        ln.items.forEach(function (it) {
          var c = colIndex(it);
          (cells[c] = cells[c] || []).push(it);
        });
        var startsRow = !firstColUsed || !!cells[0];
        if (startsRow || !cur) {
          cur = new Array(colX.length).fill('');
          rows.push(cur);
        }
        Object.keys(cells).forEach(function (c) {
          var t = joinItems(cells[c]);
          cur[c] = cur[c] ? cur[c] + ' ' + t : t;
        });
      });
      // OCR me S.No kabhi-kabhi galat padha jata hai (11 -> 1). Agar zyadatar S.No sequence me hain to baaki ko theek karo.
      var snoIdx = columns.findIndex(function (c) { return c.key === 'sno'; });
      if (extracted.mode === 'ocr' && snoIdx !== -1 && rows.length > 4) {
        var good = rows.filter(function (r, i) { return r[snoIdx] === String(i + 1); }).length;
        if (good / rows.length >= 0.8) {
          rows.forEach(function (r, i) { r[snoIdx] = String(i + 1); });
        }
      }
    } else {
      warnings.push('Items table nahi mila.');
    }

    if (!labels.length) warnings.push('Koi known field label nahi mila.');

    return { fields: fields, columns: columns, rows: rows, warnings: warnings };
  }

  window.parseQuotationPdf = async function (arrayBuffer, progress) {
    var extracted = await extractItems(arrayBuffer, progress);
    var result = parse(extracted);
    result.pages = extracted.numPages;
    result.mode = extracted.mode;
    return result;
  };
  window.__qpdfDebug = { extractItems: extractItems, parse: parse };
})();
