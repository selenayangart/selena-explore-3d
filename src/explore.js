/* =========================================================
   Explore — a rotatable semantic cluster of every painting.

   Horizontal position and depth are generated from a local TF-IDF embedding
   of each work's title, collection, theme, medium, description, and optional
   `embeddingTags`. Vertical position follows chronology, with newer works
   above older works. Quiet links connect semantic neighbours; collection
   labels mark cluster centroids.
   Collection / Theme / Medium remain multi-select filters. Selections within
   one group are inclusive; active groups intersect with one another.

   Drag to orbit, scroll to zoom, click a thumbnail to open it.
   Pure CSS 3D transforms, no libraries. Embedded on the landing page and
   reused as a focused overlay from the All Work archive.
   ========================================================= */
(function () {
  var works = (window.WORKS || []).filter(function (w) {
    return w.imagePath && w.imagePath.indexOf('TODO') === -1;
  });
  if (!works.length) return;

  function t(k) { return (window.I18N && window.I18N.t) ? window.I18N.t(k) : k; }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /* ---------- filter dimensions ---------- */
  var DIMS = {
    theme:       { i18n: 'dim.theme',       type: 'cat', get: function (w) { return w.theme || '—'; } },
    collection:  { i18n: 'dim.collection',  type: 'cat', get: function (w) { return w.collection || '—'; } },
    medium:      { i18n: 'dim.medium',      type: 'cat', get: function (w) { return w.medium || '—'; } }
  };
  var FILTER_DIMS = ['collection', 'theme', 'medium'];
  var selected = { collection: {}, theme: {}, medium: {} };
  var COLLECTION_DESCRIPTIONS = {
    'Collection A': 'explore.collection.organic',
    'Collection B': 'explore.collection.bouncy'
  };

  var SPREAD = 300;
  var rx = -16, ry = 26, scale = 1;
  var spinning = true, interactionPaused = false;
  var frameScale = 1, frameX = 0, frameY = 0, reframeTimer = 0;
  var frameCenter = null;
  var focusedMarker = null, pinnedMarker = null, previewDwellTimer = 0, hoverIntentTimer = 0, collectionAnchor = null, activeCollectionContext = '';

  var inlineHost = document.getElementById('explore-mount');
  var el, stage, scene, spinButton, collectionNote, artPreview, yearGuide, yearGuideSvg, activeYear = null, markers = [], connections = [], clusterLabels = [], built = false, returnFocus = null;

  function capture(name, properties) {
    if (window.Analytics && window.Analytics.capture) window.Analytics.capture(name, properties || {});
  }

  function profileTerms(work, key) {
    return work && work.semanticProfile && Array.isArray(work.semanticProfile[key]) ? work.semanticProfile[key] : [];
  }

  function relationshipReason(a, b) {
    var labels = { concepts: 'concept', motifs: 'motif', values: 'value', context: 'context' };
    var shared = [];
    ['concepts', 'motifs', 'values', 'context'].forEach(function (key) {
      profileTerms(a, key).forEach(function (term) {
        if (profileTerms(b, key).indexOf(term) !== -1 && shared.length < 2) shared.push({ term: term, type: labels[key] });
      });
    });
    if (!shared.length && a.theme && a.theme === b.theme) shared.push({ term: a.theme, type: 'theme' });
    if (!shared.length && a.collection && a.collection === b.collection) shared.push({ term: a.collection, type: 'collection' });
    if (!shared.length && a.medium && a.medium === b.medium) shared.push({ term: a.medium, type: 'medium' });
    return shared.map(function (item) { return item.term; }).join(' + ') || 'shared visual language';
  }

  function positionCollectionNote() {
    if (!collectionNote || !collectionAnchor || !collectionNote.classList.contains('is-visible')) return;
    var stageRect = stage.getBoundingClientRect();
    var anchorRect = collectionAnchor.getBoundingClientRect();
    var noteRect = collectionNote.getBoundingClientRect();
    var inset = 12;
    var left = anchorRect.left - stageRect.left + (anchorRect.width - noteRect.width) / 2;
    left = Math.max(inset, Math.min(stageRect.width - noteRect.width - inset, left));
    var top = anchorRect.bottom - stageRect.top + 8;
    if (top + noteRect.height > stageRect.height - inset) top = anchorRect.top - stageRect.top - noteRect.height - 8;
    collectionNote.style.left = left + 'px';
    collectionNote.style.top = Math.max(inset, top) + 'px';
  }

  function showCollectionNote(name, descriptionKey, anchor) {
    if (!collectionNote || !descriptionKey) return;
    collectionAnchor = anchor || null;
    collectionNote.querySelector('strong').textContent = name;
    var body = collectionNote.querySelector('span');
    body.dataset.i18n = descriptionKey;
    body.textContent = t(descriptionKey);
    collectionNote.classList.toggle('is-anchored', !!collectionAnchor);
    if (!collectionAnchor) {
      collectionNote.style.removeProperty('left');
      collectionNote.style.removeProperty('top');
    }
    collectionNote.classList.add('is-visible');
    collectionNote.setAttribute('aria-hidden', 'false');
    if (collectionAnchor) window.requestAnimationFrame(positionCollectionNote);
  }

  function hideCollectionNote() {
    if (!collectionNote) return;
    collectionAnchor = null;
    collectionNote.classList.remove('is-visible');
    collectionNote.classList.remove('is-anchored');
    collectionNote.setAttribute('aria-hidden', 'true');
  }

  function relatedMarkers(marker) {
    if (!marker) return [];
    var index = markers.indexOf(marker);
    return markers.map(function (candidate, candidateIndex) {
      return { marker: candidate, similarity: semanticSimilarity[index][candidateIndex] || 0 };
    }).filter(function (entry) {
      return entry.marker !== marker && entry.marker.visible !== false;
    }).sort(function (a, b) { return b.similarity - a.similarity; }).slice(0, 2);
  }

  function renderRelated(marker) {
    var related = artPreview.querySelector('.explore-related');
    var list = related.querySelector('ul');
    list.innerHTML = '';
    relatedMarkers(marker).forEach(function (entry) {
      var item = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      var title = document.createElement('span');
      var reason = document.createElement('small');
      title.textContent = entry.marker.work.title;
      reason.textContent = relationshipReason(marker.work, entry.marker.work);
      button.appendChild(title);
      button.appendChild(reason);
      button.addEventListener('click', function () { openMarkerInLightbox(entry.marker, 'related_work'); });
      item.appendChild(button);
      list.appendChild(item);
    });
    related.hidden = !list.children.length;
  }

  function showArtPreview(w, marker, source) {
    if (!artPreview || !w || !marker) return;
    var compact = !pinnedMarker && (source === 'hover' || source === 'keyboard');
    artPreview.classList.toggle('is-compact', compact);
    var image = artPreview.querySelector('img');
    image.src = w.imagePath;
    image.alt = w.title + ', ' + w.year;
    artPreview.querySelector('strong').textContent = w.title;
    artPreview.querySelector('.explore-art-preview-meta').textContent = w.year + (w.collection ? ' · ' + w.collection : '');

    var description = artPreview.querySelector('.explore-art-preview-description');
    var quote = artPreview.querySelector('.explore-art-preview-quote');
    var quoteText = quote.querySelector('p');
    var quoteCredit = quote.querySelector('cite');
    var paragraphs = [];
    var quotes = [];

    if (w.seoDescription) paragraphs.push(w.seoDescription);
    if (Array.isArray(w.description)) {
      w.description.forEach(function (block) {
        if (!block || !block.text) return;
        if (block.type === 'quote') quotes.push({ text: block.text, attribution: block.attribution || '' });
        else if (block.type === 'paragraph' && paragraphs.indexOf(block.text) === -1) paragraphs.push(block.text);
      });
    } else if (w.description) {
      var lines = String(w.description).split('\n');
      var lastLine = lines[lines.length - 1] || '';
      var looksLikeQuote = /^[“\"]/.test(lines[0]) || /^\s*~/.test(lastLine);
      if (looksLikeQuote) {
        if (/^\s*~/.test(lastLine)) lines.pop();
        quotes.push({ text: lines.join('\n'), attribution: lastLine.replace(/^\s*~\s*/, '') });
      } else if (paragraphs.indexOf(String(w.description)) === -1) {
        paragraphs.push(String(w.description));
      }
    }

    description.textContent = paragraphs.join(' ');
    description.hidden = !paragraphs.length;
    quoteText.textContent = quotes.map(function (item) { return item.text; }).join('\n\n');
    quoteCredit.textContent = quotes.map(function (item) { return item.attribution; }).filter(Boolean).join(' · ');
    quoteCredit.hidden = !quoteCredit.textContent;
    quote.hidden = !quotes.length;
    artPreview.querySelector('.explore-art-preview-open').href = '/artwork/' + w.slug + '/';
    renderRelated(marker);
    artPreview.classList.add('is-visible');
    artPreview.setAttribute('aria-hidden', 'false');
    window.clearTimeout(previewDwellTimer);
    previewDwellTimer = window.setTimeout(function () {
      if (focusedMarker === marker) capture('explore_artwork_previewed', { artwork: w.title, artwork_slug: w.slug, source: source || 'hover' });
    }, 750);
  }

  function hideArtPreview(force, immediate) {
    if (!artPreview || (pinnedMarker && !force)) return;
    window.clearTimeout(previewDwellTimer);
    if (immediate) artPreview.style.transition = 'none';
    artPreview.classList.remove('is-visible');
    artPreview.classList.remove('is-pinned');
    artPreview.classList.remove('is-compact');
    artPreview.setAttribute('aria-hidden', 'true');
    if (immediate) {
      window.requestAnimationFrame(function () { artPreview.style.removeProperty('transition'); });
    }
  }

  /* ---------- dominant-colour ----------
     Two sources, in order of trust:
       1. an explicit `color: "#rrggbb"` on the work (artist-picked, exact)
       2. otherwise sampled from the image — NOT a naive mean (which smears
          the whole canvas into mud), but a saturation-weighted hue histogram:
          neutral / near-black / near-white pixels are skipped, the remaining
          vivid pixels vote into hue buckets weighted by how saturated and
          mid-toned they are, and the peak bucket's average is the colour a
          person would actually name. Grayscale works fall back to the mean. */
  function rgbToHue(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d === 0) h = 0;
    else if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
    return h;
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2, h = 0, s = 0;
    if (d !== 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, s, l];
  }
  function hexToRgb(hex) {
    hex = String(hex).replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function dominantFromData(data) {
    var NB = 36, span = 360 / NB, buckets = {};
    var mr = 0, mg = 0, mb = 0, mn = 0;
    for (var i = 0; i < data.length; i += 4) {
      var r = data[i], g = data[i + 1], b = data[i + 2];
      if (data[i + 3] < 125) continue;
      mr += r; mg += g; mb += b; mn++;
      var hsl = rgbToHsl(r, g, b), h = hsl[0], s = hsl[1], l = hsl[2];
      if (s < 0.14 || l < 0.08 || l > 0.92) continue;          // skip neutrals + extremes
      var bi = Math.floor(h / span) % NB;
      var wgt = s * (1 - Math.abs(l - 0.5) * 0.7);             // favour vivid, mid-toned
      var bk = buckets[bi] || (buckets[bi] = { r: 0, g: 0, b: 0, w: 0 });
      bk.r += r * wgt; bk.g += g * wgt; bk.b += b * wgt; bk.w += wgt;
    }
    var best = null, bestW = 0;
    for (var k in buckets) { if (buckets[k].w > bestW) { bestW = buckets[k].w; best = buckets[k]; } }
    if (!best || mn === 0) {                                    // grayscale / monochrome → mean
      var r0 = Math.round(mr / (mn || 1)), g0 = Math.round(mg / (mn || 1)), b0 = Math.round(mb / (mn || 1));
      return { rgb: [r0, g0, b0], hue: rgbToHue(r0, g0, b0) };
    }
    var rr = Math.round(best.r / best.w), gg = Math.round(best.g / best.w), bb = Math.round(best.b / best.w);
    return { rgb: [rr, gg, bb], hue: rgbToHue(rr, gg, bb) };
  }
  function extractHues(done) {
    var pending = works.length;
    works.forEach(function (w) {
      if (typeof w.__hue === 'number') { if (--pending === 0) done(); return; }
      if (w.color) {                                           // artist-picked override
        w.__rgb = hexToRgb(w.color); w.__hue = rgbToHue(w.__rgb[0], w.__rgb[1], w.__rgb[2]);
        if (--pending === 0) done(); return;
      }
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas'); c.width = 40; c.height = 40;
          var cx = c.getContext('2d'); cx.drawImage(img, 0, 0, 40, 40);
          var res = dominantFromData(cx.getImageData(0, 0, 40, 40).data);
          w.__rgb = res.rgb; w.__hue = res.hue;
        } catch (e) { w.__rgb = [128, 128, 128]; w.__hue = 0; }
        if (--pending === 0) done();
      };
      img.onerror = function () { w.__rgb = [128, 128, 128]; w.__hue = 0; if (--pending === 0) done(); };
      img.src = w.imagePath;
    });
  }

  /* ---------- semantic embedding ---------- */
  var semanticSimilarity = [];
  var STOP_WORDS = {
    a:1, an:1, and:1, are:1, as:1, at:1, be:1, by:1, for:1, from:1, in:1,
    into:1, is:1, it:1, of:1, on:1, or:1, that:1, the:1, this:1, through:1,
    to:1, with:1, work:1, painting:1, selena:1, yang:1
  };

  function semanticKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }
  function stem(token) {
    if (token.length > 5 && /ies$/.test(token)) return token.slice(0, -3) + 'y';
    if (token.length > 5 && /ing$/.test(token)) return token.slice(0, -3);
    if (token.length > 4 && /ed$/.test(token)) return token.slice(0, -2);
    if (token.length > 4 && /s$/.test(token)) return token.slice(0, -1);
    return token;
  }
  function plainDescription(description) {
    if (!description) return '';
    if (typeof description === 'string') return description;
    if (!Array.isArray(description)) return '';
    return description.map(function (block) { return block.text || block.label || ''; }).join(' ');
  }
  function tokensFor(work) {
    var semanticText = ['concepts', 'motifs', 'values', 'context'].map(function (key) {
      return profileTerms(work, key).join(' ');
    }).join(' ');
    var text = [work.title, work.seoDescription, plainDescription(work.description), work.embeddingTags || '', semanticText].join(' ').toLowerCase();
    var tokens = text.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).map(stem).filter(function (token) {
      return token.length > 2 && !STOP_WORDS[token];
    });
    /* Categorical phrases are strong semantic signals, but remain part of the
       same embedding rather than becoming literal display axes. */
    var weighted = [
      ['collection:' + semanticKey(work.collection), 6],
      ['theme:' + semanticKey(work.theme), 5],
      ['medium:' + semanticKey(work.medium), 2]
    ];
    weighted.forEach(function (entry) {
      if (!/:$/.test(entry[0])) for (var i = 0; i < entry[1]; i++) tokens.push(entry[0]);
    });
    return tokens;
  }
  function dot(a, b) {
    var sum = 0;
    for (var key in a) if (b[key]) sum += a[key] * b[key];
    return sum;
  }
  function matVec(matrix, vector) {
    return matrix.map(function (row) {
      var sum = 0;
      for (var i = 0; i < row.length; i++) sum += row[i] * vector[i];
      return sum;
    });
  }
  function vectorNorm(vector) {
    return Math.sqrt(vector.reduce(function (sum, value) { return sum + value * value; }, 0)) || 1;
  }
  function orthogonalize(vector, bases) {
    bases.forEach(function (base) {
      var projection = 0;
      for (var i = 0; i < vector.length; i++) projection += vector[i] * base[i];
      for (var j = 0; j < vector.length; j++) vector[j] -= projection * base[j];
    });
    return vector;
  }
  function buildEmbedding() {
    var docs = works.map(tokensFor), df = {};
    docs.forEach(function (tokens) {
      var seen = {};
      tokens.forEach(function (token) { if (!seen[token]) { df[token] = (df[token] || 0) + 1; seen[token] = true; } });
    });
    var vectors = docs.map(function (tokens) {
      var counts = {}, vector = {}, length = docs.length;
      tokens.forEach(function (token) { counts[token] = (counts[token] || 0) + 1; });
      for (var token in counts) vector[token] = (1 + Math.log(counts[token])) * (Math.log((1 + length) / (1 + df[token])) + 1);
      var norm = Math.sqrt(dot(vector, vector)) || 1;
      for (var key in vector) vector[key] /= norm;
      return vector;
    });

    var n = works.length, distances = [], rowMeans = [], totalMean = 0;
    semanticSimilarity = [];
    for (var i = 0; i < n; i++) {
      distances[i] = []; semanticSimilarity[i] = []; rowMeans[i] = 0;
      for (var j = 0; j < n; j++) {
        var similarity = Math.max(0, Math.min(1, dot(vectors[i], vectors[j])));
        semanticSimilarity[i][j] = similarity;
        distances[i][j] = Math.max(0, 2 - 2 * similarity);
        rowMeans[i] += distances[i][j] / n;
      }
      totalMean += rowMeans[i] / n;
    }
    var gram = distances.map(function (row, rowIndex) {
      return row.map(function (distance, columnIndex) {
        return -0.5 * (distance - rowMeans[rowIndex] - rowMeans[columnIndex] + totalMean);
      });
    });

    var eigenvectors = [], coordinates = works.map(function () { return []; });
    for (var axisIndex = 0; axisIndex < 3; axisIndex++) {
      var vector = works.map(function (_, index) {
        return Math.sin((index + 1) * (axisIndex + 1) * 1.73) + Math.cos((index + 2) * (axisIndex + 2) * 0.91);
      });
      orthogonalize(vector, eigenvectors);
      var initialNorm = vectorNorm(vector);
      vector = vector.map(function (value) { return value / initialNorm; });
      for (var iteration = 0; iteration < 120; iteration++) {
        var next = orthogonalize(matVec(gram, vector), eigenvectors);
        var nextNorm = vectorNorm(next);
        vector = next.map(function (value) { return value / nextNorm; });
      }
      var projected = matVec(gram, vector), eigenvalue = 0;
      for (var valueIndex = 0; valueIndex < n; valueIndex++) eigenvalue += vector[valueIndex] * projected[valueIndex];
      eigenvectors.push(vector.slice());
      var magnitude = Math.sqrt(Math.max(eigenvalue, 0.0001));
      for (var workIndex = 0; workIndex < n; workIndex++) coordinates[workIndex][axisIndex] = vector[workIndex] * magnitude;
    }

    for (var coordinateIndex = 0; coordinateIndex < 3; coordinateIndex++) {
      var max = 0;
      coordinates.forEach(function (coordinate) { max = Math.max(max, Math.abs(coordinate[coordinateIndex])); });
      max = max || 1;
      coordinates.forEach(function (coordinate) { coordinate[coordinateIndex] /= max; });
    }

    /* The semantic projection can place near-identical works at the same
       point. Gently separate those neighbours so every thumbnail remains a
       usable target without changing the larger cluster structure. */
    var minSemanticGap = works.length > 18 ? 0.28 : 0.4;
    for (var relaxation = 0; relaxation < 32; relaxation++) {
      for (var first = 0; first < coordinates.length; first++) {
        for (var second = first + 1; second < coordinates.length; second++) {
          var dx = coordinates[second][0] - coordinates[first][0];
          var dy = coordinates[second][1] - coordinates[first][1];
          var dz = coordinates[second][2] - coordinates[first][2];
          var distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (distance >= minSemanticGap) continue;
          if (distance < 0.0001) {
            var angle = (first + 1) * (second + 2) * 1.618;
            dx = Math.cos(angle); dy = Math.sin(angle); dz = Math.sin(angle * 0.7) * 0.5;
            distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
          }
          var push = (minSemanticGap - distance) * 0.24;
          dx /= distance; dy /= distance; dz /= distance;
          coordinates[first][0] -= dx * push; coordinates[second][0] += dx * push;
          coordinates[first][1] -= dy * push; coordinates[second][1] += dy * push;
          coordinates[first][2] -= dz * push; coordinates[second][2] += dz * push;
        }
      }
    }

    for (var relaxedAxis = 0; relaxedAxis < 3; relaxedAxis++) {
      var relaxedMax = 1;
      coordinates.forEach(function (coordinate) { relaxedMax = Math.max(relaxedMax, Math.abs(coordinate[relaxedAxis])); });
      coordinates.forEach(function (coordinate) { coordinate[relaxedAxis] /= relaxedMax; });
    }
    var years = works.map(function (work) { return Number(work.year) || 0; }).filter(Boolean);
    var oldestYear = Math.min.apply(Math, years);
    var newestYear = Math.max.apply(Math, years);
    var yearSpan = Math.max(1, newestYear - oldestYear);

    works.forEach(function (work, index) {
      var nudge = work.embeddingNudge || {};
      var year = Number(work.year) || oldestYear;
      var chronologyY = 1 - (((year - oldestYear) / yearSpan) * 2);
      var verticalNudge = Math.max(-0.08, Math.min(0.08, Number(nudge.y) || 0));
      work.__embeddingPos = {
        x: coordinates[index][0] + (Number(nudge.x) || 0),
        y: (chronologyY * 0.72) + (coordinates[index][1] * 0.12) + verticalNudge,
        z: coordinates[index][2] * 0.84 + (Number(nudge.z) || 0)
      };
    });
  }

  /* ---------- layout + orbit ---------- */
  function currentSpread() {
    if (!stage) return SPREAD;
    if (stage.clientWidth < 600) return Math.max(150, Math.min(180, stage.clientWidth * 0.4));
    return Math.min(SPREAD, Math.max(190, stage.clientWidth * 0.39));
  }

  function layout() {
    var spread = currentSpread();
    markers.forEach(function (m) {
      var pos = m.work.__embeddingPos || { x: 0, y: 0, z: 0 };
      m.el.style.transform = 'translate3d(' +
        (pos.x * spread) + 'px,' + (pos.y * spread) + 'px,' + (pos.z * spread) + 'px)';
    });
    connections.forEach(function (connection) {
      var from = connection.from.__embeddingPos, to = connection.to.__embeddingPos;
      var dx = (to.x - from.x) * spread, dy = (to.y - from.y) * spread, dz = (to.z - from.z) * spread;
      var length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      var yaw = -Math.atan2(dz, dx) * 180 / Math.PI;
      var pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * 180 / Math.PI;
      connection.el.style.width = length + 'px';
      connection.el.style.transform = 'translate3d(' + (from.x * spread) + 'px,' + (from.y * spread) + 'px,' + (from.z * spread) + 'px) rotateY(' + yaw + 'deg) rotateZ(' + pitch + 'deg)';
    });
    clusterLabels.forEach(function (cluster) {
      var horizontalOffset = cluster.name === 'Collection B' ? Math.min(56, spread * 0.2) : Math.min(104, spread * 0.36);
      var verticalOffset = cluster.name === 'Collection B' ? 72 : 122;
      var labelX = (cluster.pos.x * spread) + (cluster.side * horizontalOffset);
      cluster.holder.style.transform = 'translate3d(' + labelX + 'px,' + ((cluster.pos.y * spread) - verticalOffset) + 'px,' + (cluster.pos.z * spread) + 'px)';
    });
    applyRotation();
  }

  function positionClusterLabels() {
    if (!stage) return;
    var stageRect = stage.getBoundingClientRect();
    clusterLabels.forEach(function (cluster) {
      var anchorRect = cluster.holder.getBoundingClientRect();
      cluster.label.style.left = (anchorRect.left - stageRect.left) + 'px';
      cluster.label.style.top = (anchorRect.top - stageRect.top) + 'px';
    });
  }

  function applyRotation() {
    if (frameCenter) {
      var yaw = ry * Math.PI / 180, pitch = rx * Math.PI / 180;
      var rotatedX = frameCenter.x * Math.cos(yaw) + frameCenter.z * Math.sin(yaw);
      var rotatedZ = -frameCenter.x * Math.sin(yaw) + frameCenter.z * Math.cos(yaw);
      var rotatedY = frameCenter.y * Math.cos(pitch) - rotatedZ * Math.sin(pitch);
      frameX = -rotatedX * currentSpread() * scale * frameScale;
      frameY = -rotatedY * currentSpread() * scale * frameScale;
    }
    scene.style.transform = 'translate3d(' + frameX + 'px,' + frameY + 'px,0) scale(' + (scale * frameScale) + ') rotateX(' + rx + 'deg) rotateY(' + ry + 'deg)';
    var counter = 'rotateY(' + (-ry) + 'deg) rotateX(' + (-rx) + 'deg) translate(-50%,-50%)';
    var sinY = Math.sin(ry * Math.PI / 180), cosY = Math.cos(ry * Math.PI / 180);
    var sinX = Math.sin(rx * Math.PI / 180), cosX = Math.cos(rx * Math.PI / 180);
    markers.forEach(function (m) {
      m.card.style.transform = counter;
      var pos = m.work.__embeddingPos || { x: 0, y: 0, z: 0 };
      var zAfterY = -pos.x * sinY + pos.z * cosY;
      var depth = Math.max(0, Math.min(1, (pos.y * sinX + zAfterY * cosX + 1.4) / 2.8));
      m.el.style.zIndex = String(Math.round(depth * 100));
      m.card.style.setProperty('--depth-brightness', String(0.82 + depth * 0.18));
    });
    positionClusterLabels();
    positionCollectionNote();
    positionYearGuides();
  }

  function positionYearGuides() {
    if (!activeYear || !yearGuideSvg || !stage) return;
    var stageRect = stage.getBoundingClientRect();
    var tick = yearGuide.querySelector('[data-year="' + activeYear + '"]');
    if (!tick) return;
    var tickRect = tick.getBoundingClientRect();
    var startX = tickRect.right - stageRect.left;
    var startY = tickRect.top + tickRect.height / 2 - stageRect.top;
    yearGuideSvg.innerHTML = '';
    markers.filter(function (marker) {
      return marker.visible !== false && Number(marker.work.year) === activeYear;
    }).forEach(function (marker) {
      var rect = marker.card.getBoundingClientRect();
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', startX);
      line.setAttribute('y1', startY);
      line.setAttribute('x2', rect.left + rect.width / 2 - stageRect.left);
      line.setAttribute('y2', rect.top + rect.height / 2 - stageRect.top);
      yearGuideSvg.appendChild(line);
    });
  }

  function setActiveYear(year) {
    activeYear = year;
    if (!yearGuide || !yearGuideSvg) return;
    yearGuide.classList.toggle('is-active', !!year);
    yearGuide.querySelectorAll('.explore-year-tick').forEach(function (button) {
      button.classList.toggle('is-active', Number(button.dataset.year) === year);
      button.setAttribute('aria-pressed', Number(button.dataset.year) === year ? 'true' : 'false');
    });
    markers.forEach(function (marker) {
      marker.el.classList.toggle('is-year-match', !!year && marker.visible !== false && Number(marker.work.year) === year);
      marker.el.classList.toggle('is-year-dim', !!year && Number(marker.work.year) !== year);
    });
    if (year) positionYearGuides();
    else yearGuideSvg.innerHTML = '';
  }

  function buildYearGuide() {
    var years = works.map(function (work) { return Number(work.year); }).filter(Boolean).filter(function (year, index, all) {
      return all.indexOf(year) === index;
    }).sort(function (a, b) { return b - a; });
    years.forEach(function (year) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'explore-year-tick';
      button.dataset.year = String(year);
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', 'Show works created in ' + year);
      button.innerHTML = '<span aria-hidden="true"></span><strong>' + year + '</strong>';
      button.addEventListener('pointerenter', function () { if (!pinnedMarker) setActiveYear(year); });
      button.addEventListener('pointerleave', function () { if (!pinnedMarker) setActiveYear(null); });
      button.addEventListener('focus', function () { setActiveYear(year); });
      button.addEventListener('blur', function () { setActiveYear(null); });
      yearGuide.appendChild(button);
    });
  }

  function setFocus(marker, source) {
    if (!marker || marker.visible === false) return;
    focusedMarker = marker;
    var neighbours = relatedMarkers(marker).map(function (entry) { return entry.marker; });
    markers.forEach(function (candidate) {
      candidate.el.classList.toggle('is-focus', candidate === marker);
      candidate.el.classList.toggle('is-neighbor', neighbours.indexOf(candidate) !== -1);
      candidate.el.classList.toggle('is-context-dim', candidate !== marker && neighbours.indexOf(candidate) === -1);
    });
    connections.forEach(function (connection) {
      var touchesFocus = connection.fromMarker === marker || connection.toMarker === marker;
      var other = connection.fromMarker === marker ? connection.toMarker : connection.fromMarker;
      var active = touchesFocus && neighbours.indexOf(other) !== -1;
      connection.el.classList.toggle('is-focus', active);
      connection.el.classList.toggle('is-context-dim', !active);
    });
    interactionPaused = true;
    showArtPreview(marker.work, marker, source);
  }

  function clearFocus(force, immediate) {
    if (pinnedMarker && !force) return;
    window.clearTimeout(hoverIntentTimer);
    focusedMarker = null;
    if (force) pinnedMarker = null;
    markers.forEach(function (marker) {
      marker.el.classList.remove('is-focus', 'is-neighbor', 'is-context-dim');
    });
    connections.forEach(function (connection) {
      connection.el.classList.remove('is-focus', 'is-context-dim');
    });
    interactionPaused = false;
    hideArtPreview(true, immediate);
  }

  function showCollectionContext(name) {
    if (!name || pinnedMarker) return;
    activeCollectionContext = name;
    var members = markers.filter(function (marker) { return marker.work.collection === name && marker.visible; });
    var neighbours = [];
    connections.forEach(function (connection) {
      var fromMember = members.indexOf(connection.fromMarker) !== -1;
      var toMember = members.indexOf(connection.toMarker) !== -1;
      var active = fromMember || toMember;
      if (active && fromMember && neighbours.indexOf(connection.toMarker) === -1) neighbours.push(connection.toMarker);
      if (active && toMember && neighbours.indexOf(connection.fromMarker) === -1) neighbours.push(connection.fromMarker);
      connection.el.classList.toggle('is-collection-link', active);
      connection.el.classList.toggle('is-context-dim', !active);
    });
    markers.forEach(function (marker) {
      var isMember = members.indexOf(marker) !== -1;
      var isNeighbour = !isMember && neighbours.indexOf(marker) !== -1;
      marker.el.classList.toggle('is-collection-member', isMember);
      marker.el.classList.toggle('is-collection-neighbor', isNeighbour);
      marker.el.classList.toggle('is-context-dim', !isMember && !isNeighbour);
    });
    clusterLabels.forEach(function (cluster) {
      cluster.label.classList.toggle('is-collection-active', cluster.label.querySelector('strong').textContent === name);
    });
    interactionPaused = true;
  }

  function clearCollectionContext(name) {
    if (name && activeCollectionContext !== name) return;
    activeCollectionContext = '';
    markers.forEach(function (marker) {
      marker.el.classList.remove('is-collection-member', 'is-collection-neighbor', 'is-context-dim');
    });
    connections.forEach(function (connection) {
      connection.el.classList.remove('is-collection-link', 'is-context-dim');
    });
    clusterLabels.forEach(function (cluster) { cluster.label.classList.remove('is-collection-active'); });
    if (!focusedMarker && !pinnedMarker) interactionPaused = false;
  }

  function openMarkerInLightbox(marker, source) {
    if (!marker || marker.visible === false) return;
    window.clearTimeout(hoverIntentTimer);
    var allWorks = window.WORKS || [];
    var workIndex = allWorks.findIndex(function (work) { return work.slug === marker.work.slug; });
    capture('explore_artwork_opened', {
      artwork: marker.work.title,
      artwork_slug: marker.work.slug,
      source: source || 'click'
    });
    clearFocus(true, true);
    if (!inlineHost) close();
    if (workIndex >= 0 && window.ArtworkDetails && window.ArtworkDetails.open) {
      window.ArtworkDetails.open(workIndex, marker.card);
    } else {
      window.location.href = '/artwork/' + marker.work.slug + '/';
    }
  }

  function frameMarkers(visibleMarkers) {
    var candidates = visibleMarkers.filter(function (marker) { return marker.visible !== false; });
    frameCenter = null;
    if (!candidates.length || candidates.length === markers.length) {
      frameX = 0; frameY = 0; frameScale = 1;
    } else {
      spinning = false;
      syncSpinButton();
      scene.classList.remove('is-reframing');
      frameX = 0; frameY = 0; frameScale = 1;
      applyRotation();
      function bounds() {
        var left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        candidates.forEach(function (marker) {
          var rect = marker.card.getBoundingClientRect();
          left = Math.min(left, rect.left); top = Math.min(top, rect.top);
          right = Math.max(right, rect.right); bottom = Math.max(bottom, rect.bottom);
        });
        return { left: left, top: top, right: right, bottom: bottom };
      }
      var first = bounds();
      frameScale = Math.min(1.45, Math.max(0.75, Math.min(
        stage.clientWidth * 0.7 / Math.max(1, first.right - first.left),
        stage.clientHeight * 0.6 / Math.max(1, first.bottom - first.top)
      )));
      applyRotation();
      var fitted = bounds();
      var stageRect = stage.getBoundingClientRect();
      frameX = stageRect.left + stageRect.width / 2 - (fitted.left + fitted.right) / 2;
      frameY = stageRect.top + stageRect.height / 2 - (fitted.top + fitted.bottom) / 2;
    }
    scene.classList.add('is-reframing');
    applyRotation();
    if (candidates.length && candidates.length !== markers.length) {
      frameCenter = candidates.reduce(function (center, marker) {
        var pos = marker.work.__embeddingPos;
        center.x += pos.x / candidates.length;
        center.y += pos.y / candidates.length;
        center.z += pos.z / candidates.length;
        return center;
      }, { x: 0, y: 0, z: 0 });
    }
    window.clearTimeout(reframeTimer);
    reframeTimer = window.setTimeout(function () { scene.classList.remove('is-reframing'); }, 650);
  }

  /* ---------- multi-select filters ---------- */
  function valuesFor(dimKey) {
    var vals = [];
    works.forEach(function (w) {
      var val = DIMS[dimKey].get(w);
      if (vals.indexOf(val) === -1) vals.push(val);
    });
    return vals.sort();
  }

  function applyFilters() {
    var visible = 0, visibleMarkers = [];
    markers.forEach(function (m) {
      var matches = FILTER_DIMS.every(function (dimKey) {
        var active = Object.keys(selected[dimKey]);
        return !active.length || !!selected[dimKey][DIMS[dimKey].get(m.work)];
      });
      m.el.classList.toggle('is-filtered-out', !matches);
      m.card.disabled = !matches;
      m.visible = matches;
      if (matches) { visible++; visibleMarkers.push(m); }
    });
    connections.forEach(function (connection) {
      var show = connection.fromMarker.visible && connection.toMarker.visible;
      connection.el.classList.toggle('is-filtered-out', !show);
    });
    clusterLabels.forEach(function (cluster) {
      var count = cluster.markers.filter(function (marker) { return marker.visible; }).length;
      cluster.holder.classList.toggle('is-filtered-out', count === 0);
      cluster.label.classList.toggle('is-filtered-out', count === 0);
      cluster.label.disabled = count === 0;
      if (count === 0 && collectionAnchor === cluster.label) hideCollectionNote();
      cluster.count.textContent = count + ' ' + (count === 1 ? t('aw.work') : t('aw.works'));
    });
    var status = el.querySelector('.explore-filter-status');
    status.textContent = visible + ' ' + (visible === 1 ? t('aw.work') : t('aw.works'));
    el.querySelector('.explore-empty').hidden = visible !== 0;
    if (focusedMarker && focusedMarker.visible === false) clearFocus(true);
    frameMarkers(visibleMarkers);
    return visible;
  }

  function linkedCollection() {
    var name = new URLSearchParams(location.search).get('collection');
    return Object.prototype.hasOwnProperty.call(COLLECTION_DESCRIPTIONS, name) ? name : '';
  }

  function syncCollectionUrl() {
    if (!inlineHost || location.protocol === 'file:') return;
    var url = new URL(location.href);
    var active = Object.keys(selected.collection);
    if (active.length === 1) url.searchParams.set('collection', active[0]);
    else url.searchParams.delete('collection');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }

  function showLinkedCollection(name) {
    FILTER_DIMS.forEach(function (dimKey) { selected[dimKey] = {}; });
    if (name) selected.collection[name] = true;
    el.querySelectorAll('.ex-chip').forEach(function (chip) {
      var on = chip.dataset.filterDimension === 'collection' && chip.dataset.filterValue === name;
      chip.classList.toggle('is-on', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    applyFilters();
  }

  function clearFilters() {
    FILTER_DIMS.forEach(function (dimKey) { selected[dimKey] = {}; });
    el.querySelectorAll('.ex-chip').forEach(function (chip) {
      chip.classList.remove('is-on');
      chip.setAttribute('aria-pressed', 'false');
    });
    var visible = applyFilters();
    syncCollectionUrl();
    capture('explore_filters_cleared', { visible_works: visible });
  }

  function buildFilters() {
    var filters = el.querySelector('.explore-filters');
    filters.innerHTML = '';
    FILTER_DIMS.forEach(function (dimKey) {
      var group = document.createElement('div');
      group.className = 'explore-filter-group';
      group.setAttribute('role', 'group');
      var labelId = 'explore-filter-' + dimKey;
      group.setAttribute('aria-labelledby', labelId);
      var label = document.createElement('span');
      label.className = 'explore-filter-label';
      label.id = labelId;
      label.setAttribute('data-i18n', 'explore.filter.' + dimKey);
      label.textContent = dimKey === 'medium' ? 'Media' : cap(dimKey);
      group.appendChild(label);

      var chips = document.createElement('div');
      chips.className = 'explore-filter-chips';
      valuesFor(dimKey).forEach(function (val) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ex-chip';
        chip.textContent = val;
        chip.dataset.filterDimension = dimKey;
        chip.dataset.filterValue = val;
        chip.setAttribute('aria-pressed', 'false');
        chip.addEventListener('click', function () {
          if (selected[dimKey][val]) delete selected[dimKey][val];
          else selected[dimKey][val] = true;
          var on = !!selected[dimKey][val];
          chip.classList.toggle('is-on', on);
          chip.setAttribute('aria-pressed', on ? 'true' : 'false');
          var visible = applyFilters();
          if (dimKey === 'collection') syncCollectionUrl();
          capture('explore_filter_changed', { category: dimKey, value: val, selected: on, visible_works: visible });
        });
        var descriptionKey = dimKey === 'collection' ? COLLECTION_DESCRIPTIONS[val] : '';
        if (descriptionKey) {
          chip.addEventListener('pointerenter', function () { showCollectionNote(val, descriptionKey); showCollectionContext(val); });
          chip.addEventListener('pointerleave', function () { hideCollectionNote(); clearCollectionContext(val); });
          chip.addEventListener('focus', function () { showCollectionNote(val, descriptionKey); showCollectionContext(val); });
          chip.addEventListener('blur', function () { hideCollectionNote(); clearCollectionContext(val); });
          chip.addEventListener('click', function () { showCollectionNote(val, descriptionKey); });
        }
        chips.appendChild(chip);
      });
      group.appendChild(chips);
      filters.appendChild(group);
    });
    if (window.I18N && window.I18N.sweep) window.I18N.sweep();
    applyFilters();
  }

  function focusCollection(name, expanded) {
    selected.collection = {};
    if (expanded) selected.collection[name] = true;
    el.querySelectorAll('.ex-chip[data-filter-dimension="collection"]').forEach(function (chip) {
      var on = expanded && chip.dataset.filterValue === name;
      chip.classList.toggle('is-on', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var visible = applyFilters();
    syncCollectionUrl();
    capture('explore_cluster_focused', { collection: name, expanded: expanded, visible_works: visible });
  }

  function syncSpinButton() {
    if (!spinButton) return;
    spinButton.classList.toggle('is-spinning', spinning);
    spinButton.setAttribute('aria-pressed', spinning ? 'true' : 'false');
    spinButton.setAttribute('aria-label', spinning ? t('explore.pauseSpin') : t('explore.startSpin'));
    spinButton.title = spinning ? t('explore.pauseSpin') : t('explore.startSpin');
  }

  function updateLabels() {
    if (window.I18N && window.I18N.sweep) window.I18N.sweep();
    syncSpinButton();
    applyFilters();
  }

  function buildSimilarityGraph() {
    var seen = {};
    works.forEach(function (work, index) {
      var neighbours = works.map(function (candidate, candidateIndex) {
        return { index: candidateIndex, similarity: semanticSimilarity[index][candidateIndex] || 0 };
      }).filter(function (entry) { return entry.index !== index; }).sort(function (a, b) {
        return b.similarity - a.similarity;
      }).slice(0, 2);

      neighbours.forEach(function (neighbour, rank) {
        if (rank > 0 && neighbour.similarity < 0.12) return;
        var low = Math.min(index, neighbour.index), high = Math.max(index, neighbour.index), key = low + ':' + high;
        if (seen[key]) return;
        seen[key] = true;
        var line = document.createElement('div');
        line.className = 'ex-connection';
        line.setAttribute('aria-hidden', 'true');
        line.style.opacity = String(0.12 + neighbour.similarity * 0.32);
        var reason = relationshipReason(works[low], works[high]);
        line.dataset.relationship = reason;
        scene.insertBefore(line, scene.firstChild);
        connections.push({
          el: line,
          from: works[low],
          to: works[high],
          fromMarker: markers[low],
          toMarker: markers[high],
          reason: reason,
          similarity: neighbour.similarity
        });
      });
    });

    var groups = {};
    markers.forEach(function (marker) {
      var name = marker.work.collection || t('lb.artwork');
      (groups[name] || (groups[name] = [])).push(marker);
    });
    Object.keys(groups).sort().forEach(function (name) {
      var groupMarkers = groups[name], pos = { x: 0, y: 0, z: 0 };
      groupMarkers.forEach(function (marker) {
        pos.x += marker.work.__embeddingPos.x;
        pos.y += marker.work.__embeddingPos.y;
        pos.z += marker.work.__embeddingPos.z;
      });
      pos.x /= groupMarkers.length; pos.y /= groupMarkers.length; pos.z /= groupMarkers.length;
      var holder = document.createElement('div');
      holder.className = 'ex-marker ex-cluster-marker';
      var label = document.createElement('button');
      label.type = 'button';
      label.className = 'ex-cluster-label';
      label.setAttribute('aria-expanded', 'false');
      var title = document.createElement('strong');
      title.textContent = name;
      var count = document.createElement('span');
      count.className = 'ex-cluster-count';
      label.appendChild(title); label.appendChild(count);
      var descriptionKey = COLLECTION_DESCRIPTIONS[name];
      if (descriptionKey) {
        label.setAttribute('aria-describedby', 'explore-collection-note');
        label.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        label.addEventListener('pointerenter', function () { showCollectionNote(name, descriptionKey, label); showCollectionContext(name); });
        label.addEventListener('pointerleave', function () {
          if (!label.classList.contains('is-expanded')) hideCollectionNote();
          clearCollectionContext(name);
        });
        label.addEventListener('focus', function () { showCollectionNote(name, descriptionKey, label); showCollectionContext(name); });
        label.addEventListener('blur', function () {
          if (!label.classList.contains('is-expanded')) hideCollectionNote();
          clearCollectionContext(name);
        });
        label.addEventListener('click', function () {
          var expanded = !label.classList.contains('is-expanded');
          clusterLabels.forEach(function (cluster) {
            cluster.label.classList.remove('is-expanded');
            cluster.label.setAttribute('aria-expanded', 'false');
          });
          label.classList.toggle('is-expanded', expanded);
          label.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          if (expanded) showCollectionNote(name, descriptionKey, label);
          else hideCollectionNote();
          focusCollection(name, expanded);
        });
      }
      scene.appendChild(holder);
      stage.appendChild(label);
      clusterLabels.push({ name: name, holder: holder, label: label, count: count, markers: groupMarkers, pos: pos, side: pos.x >= 0 ? 1 : -1 });
    });
  }

  /* ---------- build once ---------- */
  function build() {
    el = document.createElement('div');
    el.className = 'explore' + (inlineHost ? ' explore--inline is-open' : ' explore--modal');
    el.setAttribute('role', inlineHost ? 'region' : 'dialog');
    if (!inlineHost) el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Explore semantic artwork clusters in 3D');

    el.innerHTML =
      (inlineHost ? '' : '<button class="explore-close" aria-label="Close" data-i18n-aria="explore.close">&#10005;</button>') +
      '<div class="explore-tools">' +
        '<div class="explore-filters" aria-label="Filter works"></div>' +
        '<span class="explore-filter-status" aria-live="polite"></span>' +
      '</div>' +
      '<div class="explore-stage" tabindex="0" aria-label="Interactive three-dimensional semantic artwork map">' +
        '<svg class="explore-year-lines" aria-hidden="true"></svg>' +
        '<div class="explore-year-guide" aria-label="Artwork years"></div>' +
        '<aside class="explore-collection-note" id="explore-collection-note" aria-live="polite" aria-hidden="true"><strong></strong><span></span></aside>' +
        '<aside class="explore-art-preview" aria-hidden="true">' +
          '<button type="button" class="explore-art-preview-close" aria-label="Close artwork preview" data-i18n-aria="explore.closePreview">&#10005;</button>' +
          '<img src="" alt="">' +
          '<div class="explore-art-preview-copy">' +
            '<strong></strong><span class="explore-art-preview-meta"></span>' +
            '<p class="explore-art-preview-description" hidden></p>' +
            '<blockquote class="explore-art-preview-quote" hidden><p></p><cite></cite></blockquote>' +
            '<div class="explore-related" hidden><span data-i18n="explore.related">Related works</span><ul></ul></div>' +
            '<a class="explore-art-preview-open" href="#" data-i18n="explore.openArtwork">Open artwork</a>' +
          '</div>' +
        '</aside>' +
        '<p class="explore-semantic-key"><strong data-i18n="explore.semanticLabel">How to read the map</strong><span data-i18n="explore.semanticSub">Related ideas sit closer across the space</span></p>' +
          '<button type="button" class="explore-spin is-spinning" aria-pressed="true">' +
            '<span class="ex-spin-icons" aria-hidden="true">' +
              '<span class="ex-spin-icon ex-spin-play">&#9654;</span>' +
              '<span class="ex-spin-icon ex-spin-pause">&#10074;&#10074;</span>' +
            '</span>' +
            '<span data-i18n="explore.spin">Spin</span>' +
          '</button>' +
        '<div class="explore-scene"></div>' +
        '<div class="explore-empty" hidden>' +
          '<p data-i18n="explore.empty">No works match this combination.</p>' +
          '<button type="button" class="explore-clear" data-i18n="explore.clear">Clear filters</button>' +
        '</div>' +
      '</div>';
    (inlineHost || document.body).appendChild(el);

    stage = el.querySelector('.explore-stage');
    scene = el.querySelector('.explore-scene');
    spinButton = el.querySelector('.explore-spin');
    collectionNote = el.querySelector('.explore-collection-note');
    artPreview = el.querySelector('.explore-art-preview');
    yearGuide = el.querySelector('.explore-year-guide');
    yearGuideSvg = el.querySelector('.explore-year-lines');
    el.querySelector('.explore-clear').addEventListener('click', clearFilters);
    artPreview.querySelector('.explore-art-preview-close').addEventListener('click', function () {
      clearFocus(true);
      stage.focus();
    });
    artPreview.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    artPreview.addEventListener('pointerenter', function () { interactionPaused = true; });
    artPreview.addEventListener('pointerleave', function () { if (!pinnedMarker) clearFocus(false); });

    /* painting markers */
    works.forEach(function (w) {
      var m = document.createElement('div');
      m.className = 'ex-marker';
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'ex-card';
      card.setAttribute('aria-label', w.title + ', ' + w.year);
      var img = document.createElement('img');
      img.src = w.imagePath; img.alt = ''; img.loading = 'lazy';
      card.appendChild(img);
      var capEl = document.createElement('span');
      capEl.className = 'ex-card-cap';
      capEl.textContent = w.title;
      card.appendChild(capEl);
      var marker = { el: m, card: card, work: w, visible: true };
      card.addEventListener('pointerenter', function (event) {
        if (pinnedMarker || event.pointerType === 'touch') return;
        window.clearTimeout(hoverIntentTimer);
        hoverIntentTimer = window.setTimeout(function () {
          if (card.matches(':hover') && !pinnedMarker) setFocus(marker, 'hover');
        }, 140);
      });
      card.addEventListener('pointerleave', function () {
        window.clearTimeout(hoverIntentTimer);
        if (!pinnedMarker) clearFocus(false);
      });
      card.addEventListener('pointerdown', function () {
        window.clearTimeout(hoverIntentTimer);
        hideArtPreview(true, true);
      });
      card.addEventListener('focus', function () {
        window.clearTimeout(hoverIntentTimer);
        if (!pinnedMarker) setFocus(marker, 'keyboard');
      });
      card.addEventListener('blur', function () {
        window.setTimeout(function () {
          if (!pinnedMarker && !artPreview.contains(document.activeElement)) clearFocus(false);
        }, 0);
      });
      card.addEventListener('click', function () {
        window.clearTimeout(hoverIntentTimer);
        openMarkerInLightbox(marker, 'artwork_click');
      });
      m.appendChild(card);
      scene.appendChild(m);
      markers.push(marker);
    });

    buildYearGuide();

    buildSimilarityGraph();

    wireEvents();
    layout();
    buildFilters();
    if (inlineHost && linkedCollection()) showLinkedCollection(linkedCollection());
    updateLabels();
    built = true;
    if (inlineHost && linkedCollection() && location.hash === '#explore-3d') {
      requestAnimationFrame(function () {
        document.getElementById('explore-3d').scrollIntoView({ block: 'start' });
      });
    }
  }

  /* ---------- events ---------- */
  var dragging = false, moved = false, lastX, lastY, dragStartX, dragStartY, dragAxis = null, dragPointerType = '';
  function wireEvents() {
    var closeButton = el.querySelector('.explore-close');
    if (closeButton) closeButton.addEventListener('click', close);

    spinButton.addEventListener('click', function () {
      spinning = !spinning;
      syncSpinButton();
      capture('explore_spin_changed', { spinning: spinning });
    });

    /* Drag tracked on window (not via setPointerCapture) so a click still
       lands on its card — pointer capture would redirect the click to the
       stage and swallow it, breaking tap-to-open. */
    stage.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button, a')) return;
      clearFocus(true);
      hideCollectionNote();
      clusterLabels.forEach(function (cluster) {
        cluster.label.classList.remove('is-expanded');
        cluster.label.setAttribute('aria-expanded', 'false');
      });
      dragging = true; moved = false; lastX = dragStartX = e.clientX; lastY = dragStartY = e.clientY;
      dragAxis = null; dragPointerType = e.pointerType || 'mouse';
      spinning = false;
      syncSpinButton();
    });
    window.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (dragPointerType === 'touch' && !dragAxis) {
        var totalX = e.clientX - dragStartX, totalY = e.clientY - dragStartY;
        if (Math.abs(totalX) + Math.abs(totalY) < 8) return;
        dragAxis = Math.abs(totalY) > Math.abs(totalX) * 1.15 ? 'scroll' : 'orbit';
        if (dragAxis === 'scroll') { dragging = false; return; }
      }
      if (dragPointerType === 'touch' && dragAxis === 'orbit' && e.cancelable) e.preventDefault();
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      lastX = e.clientX; lastY = e.clientY;
      ry += dx * 0.4; rx -= dy * 0.4;
      rx = Math.max(-85, Math.min(85, rx));
      applyRotation();
    }, { passive: false });
    function endDrag() { dragging = false; }
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('resize', function () { layout(); applyFilters(); });

    /* The inline landing section must never capture page scrolling. Wheel
       zoom remains available only in the dedicated full-screen archive view. */
    if (!inlineHost) {
      stage.addEventListener('wheel', function (e) {
        e.preventDefault();
        scale *= e.deltaY > 0 ? 0.94 : 1.06;
        scale = Math.max(0.4, Math.min(2.4, scale));
        applyRotation();
      }, { passive: false });
    }

    stage.addEventListener('keydown', function (e) {
      if (e.target.closest('button, a') && e.key !== 'Escape') return;
      var handled = true;
      if (e.key === 'ArrowLeft') ry -= 8;
      else if (e.key === 'ArrowRight') ry += 8;
      else if (e.key === 'ArrowUp') rx = Math.max(-85, rx - 8);
      else if (e.key === 'ArrowDown') rx = Math.min(85, rx + 8);
      else if (e.key === '+' || e.key === '=') scale = Math.min(2.4, scale * 1.08);
      else if (e.key === '-' || e.key === '_') scale = Math.max(0.4, scale * 0.92);
      else if (e.key === 'Enter' && !focusedMarker) openMarkerInLightbox(markers.filter(function (marker) { return marker.visible; })[0], 'keyboard');
      else if (e.key === 'Escape') clearFocus(true);
      else handled = false;
      if (!handled) return;
      spinning = false;
      syncSpinButton();
      applyRotation();
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('keydown', function (e) {
      if (!el.classList.contains('is-open') || inlineHost) return;
      if (e.key === 'Escape') close();
    });

    var reduce = window.matchMedia('(prefers-reduced-motion:reduce)').matches;
    function tick() {
      if (spinning && !interactionPaused && !reduce && el.classList.contains('is-open')) { ry += 0.12; applyRotation(); }
      else if (collectionAnchor || scene.classList.contains('is-reframing')) {
        positionClusterLabels();
        positionCollectionNote();
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ---------- open / close ---------- */
  function open() {
    if (inlineHost) {
      inlineHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    returnFocus = document.activeElement;
    function show() {
      el.classList.add('is-open');
      layout();
      document.documentElement.classList.add('no-scroll');
      document.body.classList.add('no-scroll');
    }
    if (!built) { extractHues(function () { buildEmbedding(); build(); show(); }); }
    else { show(); }
  }
  function close() {
    if (!el || inlineHost) return;
    clearFocus(true);
    el.classList.remove('is-open');
    document.documentElement.classList.remove('no-scroll');
    document.body.classList.remove('no-scroll');
    if (returnFocus && returnFocus.focus) returnFocus.focus();
  }

  /* Any [data-explore] trigger opens the focused overlay on archive pages.
     The landing page uses the persistent inline section instead. */
  function bindTriggers(root) {
    (root || document).querySelectorAll('[data-explore]').forEach(function (node) {
      if (node.__exploreBound) return;
      node.__exploreBound = true;
      node.addEventListener('click', function (e) { e.preventDefault(); open(); });
    });
  }
  bindTriggers();

  if (inlineHost) {
    document.querySelectorAll('[data-explore-collection]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        var name = link.dataset.exploreCollection;
        if (!built || !COLLECTION_DESCRIPTIONS[name] || location.protocol === 'file:') return;
        event.preventDefault();
        var url = new URL(link.href);
        history.pushState(history.state, '', url.pathname + url.search + url.hash);
        showLinkedCollection(name);
        document.getElementById('explore-3d').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    window.addEventListener('popstate', function () {
      if (built) showLinkedCollection(linkedCollection());
    });
  }

  /* The landing page owns a permanent 3D section, so initialize it without
     waiting for a button. Colour extraction runs once for the card edges. */
  if (inlineHost) extractHues(function () { buildEmbedding(); build(); });

  /* Deep-link / no-JS fallback: all-work.html?map=1 opens the map on load. */
  if (!inlineHost && /[?&]map=1(&|$)/.test(location.search)) open();

  document.addEventListener('langchange', function () { if (built) updateLabels(); });

  window.Explore = { open: open, close: close, bindTriggers: bindTriggers };
})();
