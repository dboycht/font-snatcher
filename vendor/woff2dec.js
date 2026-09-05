// font-snatcher WOFF2 -> TTF converter (pure JS, no wasm, no eval).
// Parses WOFF2 and rebuilds a sfnt (TTF). Requires an injected Brotli
// decompressor (foliojs brotli.js) for the table data block.
// Implemented from the WOFF2 spec and fontTools' woff2.py / _g_l_y_f.py.
'use strict';

(function (global) {
  'use strict';

  var KNOWN_TAGS = [
    'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post',
    'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
    'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
    'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
    'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
    'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
    'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop',
    'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'
  ];

  var ARG_1_AND_2_ARE_WORDS = 0x0001;
  var ARGS_ARE_XY_VALUES = 0x0002;
  var WE_HAVE_A_SCALE = 0x0008;
  var MORE_COMPONENTS = 0x0020;
  var WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
  var WE_HAVE_A_TWO_BY_TWO = 0x0080;
  var WE_HAVE_INSTRUCTIONS = 0x0100;

  function bytesToAscii(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  function asciiToBytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }
  function pad4(n) { return (n + 3) & ~3; }

  function Reader(arr) {
    this.arr = arr;
    this.pos = 0;
  }
  Reader.prototype.u8 = function () { return this.arr[this.pos++]; };
  Reader.prototype.u16 = function () {
    var v = (this.arr[this.pos] << 8) | this.arr[this.pos + 1];
    this.pos += 2;
    return v;
  };
  Reader.prototype.u32 = function () {
    var v = ((this.arr[this.pos] << 24) | (this.arr[this.pos + 1] << 16) | (this.arr[this.pos + 2] << 8) | this.arr[this.pos + 3]) >>> 0;
    this.pos += 4;
    return v;
  };
  Reader.prototype.i16 = function () { var v = this.u16(); return v >= 0x8000 ? v - 0x10000 : v; };
  Reader.prototype.bytes = function (n) {
    var out = this.arr.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  };

  function readUIntBase128(r) {
    var result = 0;
    for (var i = 0; i < 5; i++) {
      var code = r.u8();
      if (i === 0 && code === 0x80) throw new Error('UIntBase128 must not start with 0x80');
      if (result & 0xfe000000) throw new Error('UIntBase128 exceeds 2**32-1');
      result = (result << 7) | (code & 0x7f);
      if ((code & 0x80) === 0) return result;
    }
    throw new Error('UIntBase128 too long');
  }

  function read255UShort(r) {
    var code = r.u8();
    if (code === 253) return r.u16();
    if (code === 254) return r.u8() + 506;
    if (code === 255) return r.u8() + 253;
    return code;
  }

  function woff2ToTtf(woff2Bytes, decompress) {
    if (!decompress || typeof decompress !== 'function') throw new Error('No brotli decompress fn');
    var arr = woff2Bytes instanceof Uint8Array ? woff2Bytes : new Uint8Array(woff2Bytes);
    var r = new Reader(arr);
    if (arr.length < 48) throw new Error('WOFF2 too short');
    if (bytesToAscii(arr.slice(0, 4)) !== 'wOF2') throw new Error('Bad WOFF2 signature');
    r.bytes(4); // consume signature
    var flavor = r.u32();
    r.u32();
    var numTables = r.u16();
    r.u16();
    r.u32();
    r.u32();
    r.u16(); r.u16();
    r.u32(); r.u32(); r.u32();
    r.u32(); r.u32();
    if (flavor === 0x74746366) throw new Error('TTC not supported');
    if (numTables === 0) throw new Error('No tables');

    var tables = [];
    var seen = {};
    for (var i = 0; i < numTables; i++) {
      var flags = r.u8();
      var tagIndex = flags & 0x3f;
      var tver = flags >> 6;
      var tag = tagIndex === 0x3f ? bytesToAscii(r.bytes(4)) : KNOWN_TAGS[tagIndex];
      if (seen[tag]) throw new Error('duplicate table tag: ' + tag);
      seen[tag] = true;
      var transformed = (tag === 'glyf' || tag === 'loca') ? tver !== 3 : tver !== 0;
      var origLength = readUIntBase128(r);
      var transformLength = 0;
      if (transformed) {
        transformLength = readUIntBase128(r);
        if (tag === 'loca' && transformLength !== 0) throw new Error('loca transformLength must be 0');
      }
      tables.push({ tag: tag, tver: tver, transformed: transformed, origLength: origLength, transformLength: transformLength });
    }

    var compressed = arr.slice(r.pos);
    var data;
    try {
      var dec = decompress(compressed);
      data = dec instanceof Uint8Array ? dec : new Uint8Array(dec);
    } catch (e) {
      throw new Error('Brotli decompress failed: ' + (e && e.message ? e.message : e));
    }
    if (!data.length) throw new Error('Empty decompressed data');
    var dr = new Reader(data);

    var glyfResult = null;
    var built = [];

    for (var j = 0; j < tables.length; j++) {
      var t = tables[j];
      if (t.tag === 'glyf') {
        if (t.transformed) {
          glyfResult = reconstructGlyfTable(dr, t);
          built.push({ tag: 'glyf', data: glyfResult.data });
        } else {
          built.push({ tag: 'glyf', data: dr.bytes(t.origLength) });
        }
      } else if (t.tag === 'loca') {
        // built later
      } else {
        built.push({ tag: t.tag, data: dr.bytes(t.origLength) });
      }
    }

    var locaEntry = tables.find(function (t) { return t.tag === 'loca'; });
    if (locaEntry) {
      var locaData;
      if (glyfResult && glyfResult.loca) {
        locaData = encodeLoca(glyfResult.loca, glyfResult.indexFormat);
        // Synchronise head.indexToLocFormat with the loca encoding we used.
        var headIdx = built.findIndex(function (b) { return b.tag === 'head'; });
        if (headIdx >= 0) {
          var hd = new Uint8Array(built[headIdx].data);
          // head.indexToLocFormat is a big-endian int16 at offset 50 (high byte
          // at 50, low byte at 51).
          hd[50] = 0;
          hd[51] = glyfResult.indexFormat === 0 ? 0 : 1;
          built[headIdx].data = hd;
        }
      } else {
        locaData = dr.bytes(locaEntry.origLength);
      }
      built.push({ tag: 'loca', data: locaData });
    }

    // Sort by tag ascending (sfnt requires; glyf sorts before loca naturally).
    built.sort(function (a, b) { return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0; });
    return buildSfnt(flavor, built);
  }

  function decodeTriplets(pointFlags, gstream) {
    var n = pointFlags.length;
    var xs = new Array(n);
    var ys = new Array(n);
    var x = 0, y = 0;
    var t = gstream.pos;
    function withSign(flag, base) { return (flag & 1) ? base : -base; }
    for (var i = 0; i < n; i++) {
      var flag = pointFlags[i] & 0x7f;
      if (flag < 10) {
        y += withSign(flag, ((flag & 14) << 7) + gstream.arr[t++]);
      } else if (flag < 20) {
        x += withSign(flag, (((flag - 10) & 14) << 7) + gstream.arr[t++]);
      } else if (flag < 84) {
        var b0 = flag - 20;
        var b1 = gstream.arr[t++];
        x += withSign(flag, 1 + (b0 & 0x30) + (b1 >> 4));
        y += withSign(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f));
      } else if (flag < 120) {
        var bq = flag - 84;
        x += withSign(flag, 1 + (((bq / 12) | 0) << 8) + gstream.arr[t]);
        y += withSign(flag >> 1, 1 + ((((bq % 12) >> 2) | 0) << 8) + gstream.arr[t + 1]);
        t += 2;
      } else if (flag < 124) {
        var b2 = gstream.arr[t + 1];
        x += withSign(flag, (gstream.arr[t] << 4) + (b2 >> 4));
        y += withSign(flag >> 1, ((b2 & 0x0f) << 8) + gstream.arr[t + 2]);
        t += 3;
      } else {
        x += withSign(flag, (gstream.arr[t] << 8) + gstream.arr[t + 1]);
        y += withSign(flag >> 1, (gstream.arr[t + 2] << 8) + gstream.arr[t + 3]);
        t += 4;
      }
      xs[i] = x;
      ys[i] = y;
    }
    return { xs: xs, ys: ys, glyphConsumed: t - gstream.pos };
  }

  function reconstructGlyfTable(dr, t) {
    dr.u16();
    var optionFlags = dr.u16();
    var numGlyphs = dr.u16();
    var indexFormat = dr.u16();
    var sizes = [];
    for (var i = 0; i < 7; i++) sizes.push(dr.u32());
    var nContourStream = new Reader(dr.bytes(sizes[0]));
    var nPointsStream = new Reader(dr.bytes(sizes[1]));
    var flagStream = new Reader(dr.bytes(sizes[2]));
    var glyphStream = new Reader(dr.bytes(sizes[3]));
    var compositeStream = new Reader(dr.bytes(sizes[4]));
    var bboxStream = new Reader(dr.bytes(sizes[5]));
    var instructionStream = new Reader(dr.bytes(sizes[6]));

    var overlapSimpleBitmap = null;
    if (optionFlags & 0x0001) {
      overlapSimpleBitmap = dr.bytes((numGlyphs + 7) >> 3);
    }

    var bboxBitmapSize = ((numGlyphs + 31) >> 5) << 2;
    var bboxBitmap = Array.prototype.slice.call(bboxStream.bytes(bboxBitmapSize));

    var glyphParts = [];
    var locaArr = [0];
    var offset = 0;
    var gstream = glyphStream;

    function i16bytes(v) { return [(v >> 8) & 0xff, v & 0xff]; }

    for (var gid = 0; gid < numGlyphs; gid++) {
      var numContours = nContourStream.i16();
      var bytes = [];
      if (numContours === 0) {
      } else if (numContours > 0) {
        var endPts = [];
        var endPoint = -1;
        for (var c = 0; c < numContours; c++) {
          endPoint += read255UShort(nPointsStream);
          endPts.push(endPoint);
        }
        var nPoints = endPts[endPts.length - 1] + 1;
        var pointFlags = [];
        for (var f = 0; f < nPoints; f++) pointFlags.push(flagStream.u8());
        var tt = decodeTriplets(pointFlags, gstream);
        gstream.pos += tt.glyphConsumed;
        // instruction length lives in glyphStream; instruction BYTES live in
        // instructionStream (per fontTools _decodeInstructions).
        var instrLen = read255UShort(gstream);
        var instructions = instructionStream.bytes(instrLen);

        var xMin, yMin, xMax, yMax;
        var hasSimpleBBox = bboxBitmap[gid >> 3] & (0x80 >> (gid & 7));
        if (hasSimpleBBox) {
          // explicit bbox from bboxStream (keep stream cursor aligned)
          xMin = bboxStream.i16(); yMin = bboxStream.i16();
          xMax = bboxStream.i16(); yMax = bboxStream.i16();
        } else {
          xMin = Infinity; yMin = Infinity; xMax = -Infinity; yMax = -Infinity;
          for (var k = 0; k < nPoints; k++) {
            if (tt.xs[k] < xMin) xMin = tt.xs[k];
            if (tt.xs[k] > xMax) xMax = tt.xs[k];
            if (tt.ys[k] < yMin) yMin = tt.ys[k];
            if (tt.ys[k] > yMax) yMax = tt.ys[k];
          }
        }
        bytes.push((numContours >> 8) & 0xff, numContours & 0xff);
        bytes = bytes.concat(i16bytes(xMin), i16bytes(yMin), i16bytes(xMax), i16bytes(yMax));
        for (var e = 0; e < endPts.length; e++) bytes = bytes.concat(i16bytes(endPts[e]));
        bytes = bytes.concat(i16bytes(instrLen));
        var ib;
        for (ib = 0; ib < instructions.length; ib++) bytes.push(instructions[ib]);

        var outFlags = new Array(nPoints);
        var outX = new Array(nPoints);
        var outY = new Array(nPoints);
        var px = 0, py = 0;
        for (var q = 0; q < nPoints; q++) {
          var dx = tt.xs[q] - px;
          var dy = tt.ys[q] - py;
          px = tt.xs[q]; py = tt.ys[q];
          // WOFF2 flag bit7 = OFF-curve; TrueType on-curve bit = 0x01.
          // Use a simple, always-valid encoding: on-curve bit only, all
          // deltas as 16-bit (X_SHORT/Y_SHORT/X_SAME/Y_SAME clear).
          var fl = (pointFlags[q] & 0x80) ? 0 : 0x01;
          outFlags[q] = fl;
          outX[q] = dx;
          outY[q] = dy;
        }
        for (var wf = 0; wf < nPoints; wf++) bytes.push(outFlags[wf]);
        for (var wx = 0; wx < nPoints; wx++) {
          bytes = bytes.concat(i16bytes(outX[wx]));
        }
        for (var wy = 0; wy < nPoints; wy++) {
          bytes = bytes.concat(i16bytes(outY[wy]));
        }
      } else {
        // composite (numContours < 0): TrueType header = nContour(-1) + bbox,
        // then component records. bbox lives at the head (per fontTools).
        bytes.push(0xff, 0xff); // numberOfContours = -1
        var hasBBox = bboxBitmap[gid >> 3] & (0x80 >> (gid & 7));
        if (hasBBox) {
          for (var bb0 = 0; bb0 < 4; bb0++) bytes = bytes.concat(i16bytes(bboxStream.i16()));
        } else {
          // spec says composites always carry bbox; be lenient with zeros
          bytes = bytes.concat([0, 0, 0, 0, 0, 0, 0, 0]);
        }
        var more = 1;
        var haveInstr = 0;
        var compCount = 0;
        while (more) {
          compCount++;
          var flags = compositeStream.u16();
          var glyphIndex = compositeStream.u16();
          bytes.push((flags >> 8) & 0xff, flags & 0xff);
          bytes.push((glyphIndex >> 8) & 0xff, glyphIndex & 0xff);
          if (flags & ARG_1_AND_2_ARE_WORDS) {
            bytes = bytes.concat(i16bytes(compositeStream.i16()), i16bytes(compositeStream.i16()));
          } else {
            bytes.push(compositeStream.u8(), compositeStream.u8());
          }
          if (flags & WE_HAVE_A_SCALE) {
            bytes = bytes.concat(i16bytes(compositeStream.i16()));
          } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
            bytes = bytes.concat(i16bytes(compositeStream.i16()), i16bytes(compositeStream.i16()));
          } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
            for (var m4 = 0; m4 < 4; m4++) bytes = bytes.concat(i16bytes(compositeStream.i16()));
          }
          more = flags & MORE_COMPONENTS;
          if (!more) haveInstr = flags & WE_HAVE_INSTRUCTIONS;
        }
        if (haveInstr) {
          var iLen = read255UShort(gstream);
          var instrs = instructionStream.bytes(iLen);
          bytes = bytes.concat(i16bytes(iLen));
          for (var ii = 0; ii < instrs.length; ii++) bytes.push(instrs[ii]);
        }
      }

      var raw = new Uint8Array(bytes);
      // loca indexFormat==0 stores offsets/2 -> every offset MUST be even.
      // Pad odd total lengths with a zero byte so loca stays valid.
      if (indexFormat === 0 && ((offset + raw.length) & 1)) {
        var paddedRaw = new Uint8Array(raw.length + 1);
        paddedRaw.set(raw, 0);
        raw = paddedRaw;
      }
      glyphParts.push(raw);
      offset += raw.length;
      locaArr.push(offset);
    }

    var total = 0;
    for (var gj = 0; gj < glyphParts.length; gj++) total += glyphParts[gj].length;
    var gdata = new Uint8Array(total);
    var go = 0;
    for (var gk = 0; gk < glyphParts.length; gk++) { gdata.set(glyphParts[gk], go); go += glyphParts[gk].length; }
    // loca indexFormat: offset/2 must fit in uint16 (<=0xFFFF*2). Our crude
    // per-point encoding makes glyphs larger than the WOFF2 source, so bump to
    // format 1 (32-bit loca) when needed to avoid overflow.
    var effIndexFormat = indexFormat;
    if (effIndexFormat === 0 && offset > 0x20000) effIndexFormat = 1;
    return { data: gdata, loca: locaArr, indexFormat: effIndexFormat };
  }

  function encodeLoca(loca, indexFormat) {
    if (indexFormat === 0) {
      var out = new Uint8Array(loca.length * 2);
      for (var i = 0; i < loca.length; i++) {
        var v = loca[i] / 2;
        out[i * 2] = (v >> 8) & 0xff;
        out[i * 2 + 1] = v & 0xff;
      }
      return out;
    }
    var out4 = new Uint8Array(loca.length * 4);
    for (var j = 0; j < loca.length; j++) {
      var vv = loca[j];
      out4[j * 4] = (vv >>> 24) & 0xff; out4[j * 4 + 1] = (vv >>> 16) & 0xff;
      out4[j * 4 + 2] = (vv >>> 8) & 0xff; out4[j * 4 + 3] = vv & 0xff;
    }
    return out4;
  }

  function buildSfnt(flavor, tables) {
    tables.sort(function (a, b) { return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0; });
    var numTables = tables.length;
    var total = 12 + 16 * numTables;
    for (var t = 0; t < numTables; t++) total += pad4(tables[t].data.length);
    var out = new Uint8Array(total);
    var w = {
      pos: 0,
      u8: function (v) { out[this.pos++] = v & 0xff; },
      u16: function (v) { out[this.pos++] = (v >> 8) & 0xff; out[this.pos++] = v & 0xff; },
      u32: function (v) {
        out[this.pos++] = (v >>> 24) & 0xff; out[this.pos++] = (v >>> 16) & 0xff;
        out[this.pos++] = (v >>> 8) & 0xff; out[this.pos++] = v & 0xff;
      },
      bytes: function (b) { out.set(b, this.pos); this.pos += b.length; }
    };
    w.u32(flavor);
    w.u16(numTables);
    var maxPow2 = 1, es = 0;
    while (maxPow2 * 2 <= numTables) { maxPow2 *= 2; es++; }
    w.u16(maxPow2 * 16);
    w.u16(es);
    w.u16(numTables * 16 - maxPow2 * 16);

    var offset = 12 + 16 * numTables;
    var offsets = [];
    for (var i = 0; i < numTables; i++) {
      w.bytes(asciiToBytes(tables[i].tag));
      w.u32(0);
      w.u32(offset);
      w.u32(tables[i].data.length);
      offsets.push(offset);
      offset += pad4(tables[i].data.length);
    }
    for (var j = 0; j < numTables; j++) {
      w.pos = offsets[j];
      w.bytes(tables[j].data);
    }
    return out;
  }

  var api = { woff2ToTtf: woff2ToTtf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.FontSnatcherWoff2 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);