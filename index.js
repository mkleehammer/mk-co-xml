
'use strict';

// TODO: Replace co-read with handcoded?

var fs = require('fs');
var debug = require('debug')('mk-co-xml');
var read = require('co-read');

var WSCHARS = ' \t\n\r\v';
var SPECIAL = '\\>="\'&;' + WSCHARS;

var TOKENEND = WSCHARS + '=/>';
var TEXTSPECIAL = '<&';

var CDATA_START = '<![CDATA[';
var CDATA_END   = ']]>';

var ENTITIES = [
  ['&lt;',   '<'],
  ['&gt;',   '>'],
  ['&amp;',  '&'],
  ['&apos;', "'"],
  ['&quot;', '"']
];


function Parser() {

  this.name = null;
  // The name of the XML source, such as a filename, used in error messages.

  this.source = null;
  // The readable stream we are parsing.  This will be null if we are parsing
  // directly from a string.  (The string is already in memory, so why would we
  // want to wrap it in a fake stream?)

  this.buffer = null;
  // Data we've read from source.

  this.offset = 0;
  // The offset into `buffer` for the next unread character.
}

Parser.prototype = Object.create(null, {

  remaining: {
    get: function() {
      return (this.buffer.length - this.offset);
    }
  },

  _closeStream: {
    // An internal function that closes the stream (to cleanup ASAP) but does
    // not close the entire parser.  In particular, the buffer remains since we
    // may still be reading from it.

    value: function _closeStream() {

      if (this.source) {
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
      this._closeStream();

      this.name   = null;
      this.buffer = null;
      this.offset = 0;
    }
  },

  readString: {
    value: function(name, s) {
      console.assert(arguments.length == 2, 'Forgot the name parameter to readString?');

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
    value: function _dump() {
      var desc = Array.prototype.join.call(arguments, ' ');

      if (this.buffer == null)
        debug('%s: closed', desc);
      else
        debug('%s: offset=%s buffer={%s} remaining=%d', desc, this.offset,
              this.buffer.slice(this.offset, this.offset + 30),
              (this.buffer.length - this.offset));
    }
  },

  _throwError: {
    value: function _throwError(error) {
      throw new Error(error + '\noffset=' + this.offset + '\nbuffer="' +
                      this.buffer.slice(this.offset, this.offset + 30) + '"');
    }
  },

  _throwExpected: {
    value: function _throwExpected(expected) {
      debug('DUMP: offset=%s buffer=%s', this.offset, this.buffer);
      throw new Error('Expected ' + expected + ' but found "' +
                      this.buffer.slice(this.offset, this.offset + 30) + '"');
    }
  },

  _bufferMore: {
    value: function* _bufferMore(length) {
      // A request to add more data to the buffer.  Returns true if the requested
      // amount was added and false otherwise.
      //
      // length: The minimum amount to read before returning.  If EOF is reached
      //         before this amount can be added, false is returned.  If not
      //         provided 1 is used.
      //
      // Obviously we hope the stream will return a large amount of data instead
      // of just `length` but we don't have control over this.

      if (!this.source)
        return false;

      var totalLength = this.buffer.length + (length || 1);

      debug('_bufferMore: length=%d buffer=%s total=%s', length, this.buffer.length, totalLength);

      var text;
      while ((text = yield read(this.source)) != null) {
        this.buffer += text;
        if (this.buffer.length >= totalLength)
          return true;
      }

      this._closeStream();

      return false;
    }
  },

  _ensure: {
    value: function* _ensure(needed) {
      // Reads until there is at least `needed` characters in the buffer.  Returns
      // true if it was able to read the requested number of characters and false if
      // the stream ended before.
      //
      // Be careful!  If there is already `needed` characters then it returns
      // immediately without reading more.  If you are *scanning* forward in a
      // buffer instead of removing data you'll need to ask for this.remaining
      // *plus* the extra you need.

      // debug('_ensure: %d', needed)

      var have = (this.buffer.length - this.offset);

      if (have >= needed) {
        // debug('_ensure: already have: %d', this.buffer.length - this.offset);
        return true;
      }

      return yield this._bufferMore(needed - have);
    }
  },

  _normalizeBuffer: {
    value: function _normalizeBuffer() {
      if (this.offset) {
        this.buffer = this.buffer.slice(this.offset);
        this.offset = 0;
      }
    }
  },

  _skipWhitespace: {
    value: function* _skipWhitespace() {
      // Since Javascript doesn't have a way to test a regular expression in the
      // middle of a string, we'll manually skip whitespace.  An isspace would be
      // handy too.

      this._dump('_skipWhitespace');

      while (true) {
        // debug('_skipWhitespace: TOP offset=%s, length=%s', this.offset, this.buffer.length);

        while (this.offset < this.buffer.length) {
          // debug('_skipWhitespace: offset=%s, char=%s', this.offset, this.buffer[this.offset]);
          if (WSCHARS.indexOf(this.buffer[this.offset]) === -1) {
            // debug('_skipWhitespace: non-whitespace found', this.buffer[this.offset]);
            return true;
          }
          this.offset += 1;
        }

        // We skipped all characters in the buffer.  We'll use _ensure(1) to reload
        // the buffer which will actually load as much as the OS has buffered for
        // us, not just one character.
        if (!(yield this._ensure(1))) {
          // debug('_skipWhitespace: _ensure returned false');
          return false;
        }
      }
    }
  },

  lookingAt: {
    value: function* lookingAt(text) {
      // Returns true if the buffer starts with `text`.

      if (!(yield this._ensure(text.length)))
        return false;

      var b = (this.buffer[this.offset] === text[0] && this.buffer.slice(this.offset, this.offset + text.length) === text);
      this._dump('lookingAt "' + text + '" = ' + b);
      return b;
    }
  },

  skipPast: {
    value: function* skipPast(text) {
      var i = this.offset;
      var c = text[0];

      while (true) {
        var b = this.buffer;

        for (; i <= b.length - text.length; i++) {
          if (b[i] === c && (b.slice(i, i+text.length) === text)) {
            this.offset = i + text.length;
            return;
          }
        }

        if (!(yield this._bufferMore()))
          this._throwError('Did not find "' + text + '"');
      }
    }
  },

  read: {
    value: function* read() {
      // Returns the next SAX event or undefined when finished.

      if (this.buffer && this.offset === this.buffer.length)
        this.close();

      if (this.buffer === null)
        return null;

      this._normalizeBuffer();

      this._dump('top of read');

      if (this.closeTag) {
        var item = { type: 'elementEnd', tag: this.closeTag };
        this.closeTag = null;
        return item;
      }

      // while (true) {
      for (let i = 0; i < 10; i++) {
        if (this.buffer == null)
          return undefined;

        if (!(yield this.lookingAt('<')))
          return yield* this.readTextNode();

        if (yield this.lookingAt('</')) {
          return yield* this.parseElementEnd();
        }

        if (yield this.lookingAt('<?')) {
          yield* this.skipPast('?>');
        } else if (yield this.lookingAt('<!--')) {
          yield* this.skipPast('-->');
        } else if (yield this.lookingAt('<![CDATA[')) {
          return yield* this.parseCData();
        } else {
          return yield* this.parseElementStart();
        }
      }
    }
  },

  parseElementStart: {
    value: function* parseElementStart() {
      this._dump('parseElementStart');

      this._normalizeBuffer();

      if (this.buffer[this.offset] != '<')
        this._throwExpected('<');

      this.offset++;

      var item = {
        type: 'elementStart',
        tag: yield this.readToken(),
        attributes: {}
      };

      // Gather attributes.
      while (true) {
        yield this._skipWhitespace();

        if (this.offset === this.buffer.length)
          throw new Error('Premature EOF in tag "<' + item.tag);

        if (yield this.lookingAt('/>')) {
          this._dump('endTag');

          this.closeTag = item.tag;
          return item;
        }

        if (yield this.lookingAt('>')) {
          this.offset += 1;
          return item;
        }

        var pair = yield this._parseAttribute();
        item.attributes[pair[0]] = pair[1];
      }
    }
  },

  parseCData: {
    value: function* parseCData() {
      this._dump('parseCData');

      this.offset += CDATA_START.length;

      var start = this.offset;

      yield this.skipPast(CDATA_END);

      return {
        type: 'cdata',
        value: this.buffer.slice(start, this.offset - CDATA_END.length)
      };
    }
  },

  parseElementEnd: {
    value: function* parseElementEnd() {
      this._dump('readElementEnd');

      this.offset += 2; // skip </

      var item = {
        type: 'elementEnd',
        tag: yield this.readToken()
      };

      if (!(yield this.lookingAt('>')))
        this._throwError('No closing bracket for </' + item.tag);

      this.offset += 1; // skip >

      return item;
    }
  },

  _parseAttribute: {
    value: function* _parseAttribute() {
      this._dump('_parseAttribute');

      var name = yield this.readToken();
      yield this._skipWhitespace();
      if (!(yield this.lookingAt('=')))
        this._throwExpected('Equals after attribute name');

      this.offset += 1;

      yield this._skipWhitespace();
      var value = yield this._readString();

      return [name, value];
    }
  },

  readToken: {
    value: function* readToken() {
      // Reads the token (word) at offset.  Stops at EOF, whitespace, or one of the
      // special characters.
      var start = this.offset;
      yield this.scanFor(TOKENEND);
      if (start === this.offset)
        this._throwExpected('token');
      return this.buffer.slice(start, this.offset);
    }
  },

  readTextNode: {
    value: function* readTextNode() {
      // Reads until the next tag.  If an entity is found, it is turned into a
      // Javascript character so that an entire string is returned.

      this._dump('readTextNode');

      var text = '';

      while (true) {
        var start = this.offset;
        yield this.scanFor('<&');
        if (this.offset !== start) {
          text += this.buffer.slice(start, this.offset);
        }

        if (this.buffer === null || this.buffer[this.offset] === '<') {
          // Either hit EOF or a tag/comment.  Return what we have, if any.
          break;
        }

        // We must have hit '&', so convert to a text character and continue.
        text += yield this.readReference();
      }

      if (text === '')
        return undefined;

      return { type: 'text', text: text };
    }
  },

  readReference: {
    value: function* readReference() {
      console.assert(this.buffer[this.offset] === '&');

      if (!(yield this._ensure(4)))
        this._throwError('Invalid or incomplete entity reference');

      for (let e = 0; e < ENTITIES.length; e++)
        if (yield* this.lookingAt(ENTITIES[e][0])) {
          this.offset += ENTITIES[e][0].length;
          return ENTITIES[e][1];
        }

      var i = this.offset + 1;

      if (this.buffer[i++] !== '#')
        this._throwError('Invalid entity reference');

      var radix = 10;
      if (this.buffer[i] === 'x') {
        radix = 16;
        i += 1;
      }

      if (!(yield this.scanFor(';')))
        this._throwError('Invalid numeric character reference');

      var digits = this.buffer.slice(i, this.offset);

      var re = (radix === 10) ? /^\d{1,7}$/ : /^[a-zA-Z0-9]{1,6}$/;

      if (!re.test(digits))
        this._throwError('Invalid numeric character reference: "&' + digits + ';"' );

      digits = parseInt(digits, radix);

      this.offset += 1; // skip ;

      return (String.fromCodePoint) ? String.fromCodePoint(digits) : fromCodePoint(digits);
    }
  },

  scanFor: {
    value: function* scanFor(chars) {
      // Scans forward until one of the characters in `chars` is found.  Returns
      // true if one of the characters was found and false if EOF was hit.

      this._dump('scanFor', chars);

      var i = this.offset;

      while (true) {
        var b = this.buffer;

        for (var c = b.length; i < c; i++)
          if (chars.indexOf(b[i]) !== -1) {
            this.offset = i;
            return true;
          }

        if (!(yield this._bufferMore()))
          return false;
      }
    }
  },

  _readString: {
    value: function* _readString() {
      // Returns the quoted string at the beginning of the buffer.  (If
      // Javascript had *development-only* assertions like every other
      // programming language on earth, we'd assert that there is a quote here.)
      //
      // The next character is either a double or single quote.  Scan forward to
      // find the closing quote.  If we see a backslash, skip the character
      // after it, which could be a quote: "ignore \"these\" quotes"

      this._dump('_readString');
      var quote = this.buffer[this.offset];
      var escaped = false;

      var start = ++this.offset;

      var i = start;

      while (true) {
        var b = this.buffer;
        // (Don't move this out of the while loop.  this.buffer is an immutable
        // string so it gets *replaced* by this._ensure below.)

        for (; i < b.length; i++) {
          var ch = b[i];
          if (ch === quote && !escaped) {
            this.offset = i+1;
            var s = this.buffer.slice(start, i);
            this._dump('_readString: "' + s + '"');
            return s;
          }

          if (ch === '\\') {
            escaped = !escaped;
          } else {
            escaped = false;
          }
        }


        if (!(yield this._ensure(this.remaining + 1)))
          this._throwExpected('End quote');
      }
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

module.exports.Parser = Parser;
