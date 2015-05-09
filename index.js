
'use strict';

// Parsing
// -------
//
// For speed we are reading in a buffer (64K on OS X 10.10) at a time, parsing
// events from all complete XML, and buffering those events in `this.events`.
// If the last item in the buffer is not complete an EndOfBufferError is thrown
// which is simply used to unwind the stack to the top.  We then hand out the
// buffered events.  When we run out, we read more into the text buffer and
// start again.
//
// This design requires that parsers for each element can be restarted in the
// case they were incomplete before.  Be sure to not update `this.offset` until
// the XML element has been completely parsed.
//
// Warning
// -------
//
// Node streams basically suck.  They are designed for event driven only, so in
// the ES7 await world they are really going to suck.  That would be a good
// point for someone to replace node with a competing product.
//
// Right now I'm assuming that a null return from stream.read() indicates we've
// hit EOF, but that is not how node streams work.  They don't have a way to
// yield and wait for data without events.  Later we'll have to implement some
// promises that watch for "readable" and "end".
//
// Assertions
// ----------
//
// I've long maintained that Javascript's designers completely misunderstood
// assertions and thought they were just simplified 'if' statements primarily
// useful for unit testing.  They should read "Writing Solid Code" to get an
// idea of how they originally worked.  The main point of them is to be able to
// disable them in production without paying *any* performance penalty.
//
// Since it is not possible to disable them, I comment them out.  I use a local
// function ASSERT which emphasizes it is not a normal assert and it formats
// using util.format.  Be sure all of these are commented out before merging to
// master.  To make this easy, they *must* fit on one line.


// TODO: Replace co-read with handcoded?

var fs = require('fs');
var util = require('util');
var debug = require('debug')('mk-co-xml');
var read = require('co-read');

var CDATA_START = '<![CDATA[';
var CDATA_END   = ']]>';

function ASSERT(cond, msg) {
  if (cond)
    return;
  var args = Array.prototype.slice.call(arguments, 1);
  throw new Error('Assert failed: ' + util.format.apply(null, args));
}


function EndOfBufferError() {
  // An error type used to "pop out" of parsing when we hit the end of stream.
  Error.call(this, 'end of stream');
  Error.captureStackTrace(this, this.constructor);
  this.name = 'EndOfBufferError';
}
EndOfBufferError.prototype = Object.create(Error.prototype);
EndOfBufferError.prototype.constructor = EndOfBufferError;


function Parser() {

  this.name = null;
  // The name of the XML source, such as a filename, used in error messages.

  this.events = [];
  // Events that have already been parsed from the XML.

  this.source = null;
  // The readable stream we are parsing.  This will be null if we are parsing
  // directly from a string.  (The string is already in memory, so why would we
  // want to wrap it in a fake stream?)
  //
  // This is closed and set to null when we have finished reading from it.

  this.isClosed = false;

  this.buffer = null;
  // XML text being processed.

  this.offset = 0;
  // The offset into `text` for the next unread
}

Parser.prototype = Object.create(null, {

  read: {
    value: function* read() {
      // Returns the next event or null if all events have been read.

      while (true) {
        if (this.events.length)
          return this.events.shift();

        if (this.isClosed)
          return null;

        yield this._bufferEvents();
      }
    }
  },

  readMany: {
    value: function* read() {
      // Like read but returns all buffered events.

      while (true) {
        if (this.events.length) {
          var e = this.events;
          this.events = [];
          return e;
        }

        if (this.isClosed)
          return null;

        yield this._bufferEvents();
      }
    }
  },

  _bufferEvents: {
    value: function* _bufferEvents() {
      // Reads more XML and buffers up more events into `this.events`.

      // var startBuffer = this.buffer ? this.buffer.length : null;

      if (this.source) {
        var text = yield read(this.source);
        if (text != null)
          this.buffer += text;
        else
          this._closeStream();
      }

      // var fullBuffer = this.buffer ? this.buffer.length : null;

      try {
        this._parse();
      } catch (err) {
        if (err.name !== 'EndOfBufferError')
          throw err;

        // This is our normal indication that we've parsed as much as we could
        // from the current buffer.
        // debug('end-of-buffer notification from: %s', err.stack);
        if (!this.source)
          throw new Error('Unexpected end-of-stream.  Remaining: ' + this.buffer.length + ' characters');
      }

      if (this.offset !== 0) {
        this.buffer = this.buffer.slice(this.offset);
        this.offset = 0;
      }

      // var afterBuffer = this.buffer ? this.buffer.length : null;
      // debug('PARSE: events=%j before=%s total=%s left-over=%s', this.events.length, startBuffer, fullBuffer, afterBuffer);
    }
  },

  _parse: {
    value: function _parse() {
      // Parse as much XML as possible from `this.buffer` into events.  Update
      // `this.offset` to indicate how much we've consumed.  (We don't remove it
      // piecemeal to eliminate having more objects to track.)

      var b = this.buffer;

      while (true) {
        if (this.offset >= b.length) {
          // ASSERT(this.offset === b.length, 'offset=%s > length=%s', this.offset, b.length);

          if (!this.source)
            this.close();

          return;
        }

        var ch = b[this.offset];

        if (ch !== '<') {
          this._parseTextNode();
          continue;
        }

        if (this._matches('</')) {
          this._parseElementEnd();
          continue;
        }

        if (this._matches('<?')) {
          this._skipDirective();
          continue;
        }

        if (this._matches('<!--')) {
          this._skipComment();
          continue;
        }

        if (this._matches('<![CDATA[')) {
          this._parseCData();
          continue;
        }

        this._parseElementStart();
      }
    }
  },

  _matches: {
    value: function _matches(s, i) {
      // Determines if the next characters in the buffer match `s`.  Returns
      // true or false.  If everything matches up to the end of the stream,
      // EndOfBufferError is thrown.
      //
      // i: Optional index to use instead of `this.offset`.

      // REVIEW: I don't perform a length check and throw EndOfBufferError early
      // since we can tell if it is not a match without having all characters.
      // For example, if you are looking or "<!--" and you only have "xyz", it
      // is not a match even though we are looking for 4 characters.
      //
      // I'm not sure if changing it would be any kind of optimization since we
      // hit the buffer less often than not.

      var b = this.buffer;

      var lb = this.buffer.length;
      var ls = s.length;

      var ib = (i != null) ? i : this.offset; // index into b
      var is = 0;                             // index into s

      for (; is < ls; ib++, is++) {
        if (ib == lb)
          throw new EndOfBufferError();
        if (b[ib] !== s[is])
          return false;
      }

      return true;
    }
  },

  _skipDirective: {
    value: function _skipDirective() {
      // Skip forward past '?>'.

      var b = this.buffer;
      var l = this.buffer.length;
      for (var i = this.offset + 2; i < l; i++) {
        if (b[i] === '?') {
          if (i === l-1)
            break;
          if (b[i+1] === '>') {
            this.offset = i + 2;
            return;
          }
        }
      }

      throw new EndOfBufferError();
    }
  },

  _closeStream: {
    // An internal function that closes the stream (to cleanup ASAP) but does
    // not close the entire parser.  In particular, the buffer remains since we
    // may still be reading from it.

    value: function _closeStream() {

      if (this.source) {
        // this._dump('_closeStream closing');

        // The source may have autoclosed so ignore errors.
        var methods = ['end', 'close', 'destroy'];
        for (var i = 0; i < methods.length; i++) {
          if (this.source[methods[i]]) {
            try { this.source[methods[i]](); } catch (error) { }
            break;
          }
        }

        this.source = null;
      }
    }
  },

  close: {
    value: function close() {
      // this._dump('close');
      this._closeStream();

      this.name     = null;
      this.buffer   = null;
      this.offset   = 0;
      this.isClosed = true;
    }
  },

  readString: {
    value: function(name, s) {
      // // ASSERT(arguments.length == 2, 'Forgot the name parameter to readString?');

      this.name = name;
      this.source = null;
      this.buffer = s;
      this.offset = 0;
    }
  },

  readFile: {
    value: function readFile(filename) {
      // (First in case it throws an exception - nothing has been set)
      this.source = fs.createReadStream(filename, 'r');
      this.name = filename;
      this.buffer = '';
      this.offset = 0;
    }
  },

  readStream: {
    value: function(filename, source) {
      this.name   = filename;
      this.source = source;
      this.buffer = '';
      this.offset = 0;
    }
  },

  _dump: {
    value: function _dump(desc, offset) {
      if (offset == null)
        offset = this.offset;

      if (this.buffer == null)
        debug('%s: closed', desc);
      else
        debug('%s: offset=%s text={%s} remaining=%d source=%s', desc, offset,
              this.buffer.slice(offset, offset + 100),
              (this.buffer.length - offset),
              (this.source != null)
             );
    }
  },

  _throwError: {
    value: function _throwError(error) {
      throw new Error(error + '\noffset=' + this.offset + '\ntext="' +
                      this.buffer.slice(this.offset, this.offset + 100) + '"');
    }
  },

  _throwExpected: {
    value: function _throwExpected(expected) {
      debug('DUMP: offset=%s text=%s', this.offset, this.buffer);
      throw new Error('Expected ' + expected + ' but found "' +
                      this.buffer.slice(this.offset, this.offset + 100) + '"');
    }
  },

  _parseElementStart: {
    value: function _parseElementStart() {

      var b = this.buffer;
      var l = b.length;

      // Since parsing always starts over, be sure we have the '>' before
      // putting anything into this.events.  If the buffer sizes are large
      // enough, the odds of it actually being in the buffer far outweigh the
      // odds of it not, so we won't do a pre-scan.

      var i = afterToken(b, this.offset + 1);
      var tag = b.slice(this.offset + 1, i);

      i = afterWhitespace(b, i);

      var attrs = {};

      while (b[i] !== '/' && b[i] !== '>') {
        var nameStart = i;
        var nameStop = afterToken(b, i);

        i = afterWhitespace(b, nameStop);
        if (b[i] !== '=')
          this._throwError('Expected "=" after attribute name, not "' + b[i] + '"');
        i = afterWhitespace(b, i+1);

        var stringStart = i;
        var stringStop  = afterString(b, i);

        var str = b.slice(stringStart+1, stringStop-1);
        str = replaceEntityRefs(str);
        attrs[b.slice(nameStart, nameStop)] = str;

        i = afterWhitespace(b, stringStop);
      }

      if (b[i] === '/') {
        if (i === l-1)
          throw new EndOfBufferError();
        if (b[i+1] !== '>')
          this._throwError('Expected />');
      }

      this.events.push({ type: 'start', tag: tag, attrs: attrs });

      if (b[i] === '/') {
        this.events.push({ type: 'end', tag: tag });
        i++;
      }

      this.offset = i + 1;
    }
  },

  _parseCData: {
    value: function _parseCData() {
      var b = this.buffer;
      var l = b.length;

      for (var i = this.offset + CDATA_START.length; i < l; i++) {
        if (b[i] === ']' && this._matches(CDATA_END, i)) {
          this.events.push({ type: 'cdata', data: b.slice(this.offset + CDATA_START.length, i) });
          this.offset = i + CDATA_END.length;
          return;
        }
      }

      throw new EndOfBufferError();
    }
  },

  _parseElementEnd: {
    value: function _parseElementEnd() {
      var b = this.buffer;
      var l = this.buffer.length;

      for (var i = this.offset + 2; i < l; i++) {
        if (b[i] === '>') {
          this.events.push({ type: 'end', tag: b.slice(this.offset+2, i) });
          this.offset = i + 1;
          return;
        }
      }

      throw new EndOfBufferError();
    }
  },

  _parseTextNode: {
    value: function _parseTextNode() {
      // Reads until the next tag.  If an entity is found, it is turned into a
      // Javascript character so that an entire string is returned.

      var b = this.buffer;
      var l = this.buffer.length;

      for (var i = this.offset + 1; i < l; i++)
        if (b[i] === '<')
          break;

      if (i === l) {
        // We've hit the i of the buffer.  Unlike other parts of the parser,
        // if we can't get more text then it is ok.

        if (this.source !== null)
          throw new EndOfBufferError();
      }

      this.events.push({ type: 'text', text: replaceEntityRefs(b.slice(this.offset, i)) });
      this.offset = i;
    }
  }
});

/*! http://mths.be/fromcodepoint v0.1.0 by @mathias */

function fromCodePoint () {
  var stringFromCharCode = String.fromCharCode;
  var floor = Math.floor;
  var MAX_SIZE = 0x4000;
  var codeUnits = [];
  var highSurrogate;
  var lowSurrogate;
  var index = -1;
  var length = arguments.length;
  if (!length) {
    return '';
  }
  var result = '';
  while (++index < length) {
    var codePoint = Number(arguments[index]);
    if (
      !isFinite(codePoint) ||       // `NaN`, `+Infinity`, or `-Infinity`
      codePoint < 0 ||              // not a valid Unicode code point
      codePoint > 0x10FFFF ||       // not a valid Unicode code point
      floor(codePoint) != codePoint // not an integer
    ) {
      throw new RangeError('Invalid code point: ' + codePoint);
    }
    if (codePoint <= 0xFFFF) { // BMP code point
      codeUnits.push(codePoint);
    } else { // Astral code point; split in surrogate halves
      // http://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
      codePoint -= 0x10000;
      highSurrogate = (codePoint >> 10) + 0xD800;
      lowSurrogate = (codePoint % 0x400) + 0xDC00;
      codeUnits.push(highSurrogate, lowSurrogate);
    }
    if (index + 1 == length || codeUnits.length > MAX_SIZE) {
      result += stringFromCharCode.apply(null, codeUnits);
      codeUnits.length = 0;
    }
  }
  return result;
}

var ENTITIES = {
  'lt':   '<',
  'gt':   '>',
  'amp':  '&',
  'apos': "'",
  'quot': '"'
};

function replaceEntityRefs(text) {
  var re = /([^&]*)&([^;]+);/g;

  // If there are no entities return the text as-is.  (If there are rarely
  // entity refs, would it be faster to use indexOf?  If so, I would do it
  // before eating the overhead of calling this function.)

  var m = re.exec(text);
  if (!m)
    return text;

  var parts = [];

  var lastIndex;

  do {
    lastIndex = re.lastIndex;

    if (m[1].length) // text before the
      parts.push(m[1]);

    var ref = m[2];
    var val = ENTITIES[ref];
    if (!val) {
      var d = /^#(?:x([0-9A-F]{1,6}))|([0-9]{1,7})$/i.exec(ref);
      if (!d)
        throw new Error('Invalid entity reference: "' + ref + '"');

      var digits, radix;
      if (d[1]) {
        digits = d[1];
        radix  = 16;
      } else {
        digits = d[2];
        radix  = 10;
      }

      val = parseInt(digits, radix);
      val = (String.fromCodePoint) ? String.fromCodePoint(val) : fromCodePoint(val);
    }

    parts.push(val);

    m = re.exec(text);
  } while (m);

  if (lastIndex < text.length)
    parts.push(text.slice(lastIndex));

  return parts.join('');
}

function afterToken(b, i) {
  // Returns the index of the first character after the token at `i`.
  //
  // This is designed for valid XML, so I don't stop at invalid ones.  Instead I
  // stop at special characters.  Note that not all Unicode whitespace
  // characters are looked for.

  // ASSERT(typeof i === 'number' && i <= b.length, 'i=%s', i);

  for (var l = b.length; i < l; i++) {
    switch (b[i]) {
    case ' ':
    case '\t':
    case '\n':
    case '\r':
    case '\v':
    case '/':
    case '>':
    case '"':
    case "'":
    case "=":
      return i;
    }
  }
  throw new EndOfBufferError();
}

function afterWhitespace(b, i) {
  // Returns the index of the first character at or after `i` that is not
  // whitespace.  Note that I have not included all Unicode whitespace
  // characters here (yet).

  // ASSERT(typeof i === 'number' && i <= b.length, 'i=%s', i);

  for (var l = b.length; i < l; i++) {
    switch (b[i]) {
    case ' ':
    case '\t':
    case '\n':
    case '\r':
    case '\v':
      break;
    default:
      return i;
    }
  }
  throw new EndOfBufferError();
}

function afterString(b, i) {
  // Returns the index of the first character after the closing quote of the
  // string at `i`.

  // ASSERT(typeof i === 'number' && i <= b.length, 'i=%s', i);
  // ASSERT(b[i] === '"' || b[i] === "'", 'expected quote: {}', b.slice(i, i+30));

  var quote = b[i++];

  var l = b.length;

  for (; i < l; i++) {
    var ch = b[i];
    if (ch === quote)
      return i + 1; // we want "after"
  }

  throw new EndOfBufferError();
}

module.exports.Parser = Parser;
