
var assert = require("assert");

var xmls = require('../index.js');
var co = require('co');

describe('from stream', function() {

  function test(xml, expect, done) {
    var Readable = require('stream').Readable;

    var rs = new Readable();

    rs._read = function () {
      // Use a custom function instead of push so Readable doesn't buffer it all
      // and give it to us in one chunk.
      if (xml.length)
        rs.push(xml.shift());
      else
        rs.push(null);
    };

    co(function*() {
      var parser = new xmls.Parser();

      parser.readStream("xml", rs);

      var expected;
      for (var i = 0; i < expect.length; i++) {
        expected = expect[i];
        var got = yield parser.read();
        if (expected === null && got === null)
          break;
        assert.deepEqual(expected, got);
      }
      assert.equal(expected, null, 'Did not complete');
    }).then(function() {
      done();
    }, function(error) {
      done(error);
    });
  }


  it('should allow text node at end', function(done) {
    // If we reach the end-of-buffer while parsing a text node we don't know if
    // we should continue, so we stop since there might be more data in the
    // buffer.

    var xml = ["<a>testing</a>end"];
    var expect = [
      { type: 'start', tag: 'a', attrs: {} },
      { type: 'text', text: 'testing' },
      { type: 'end', tag: 'a' },
      { type: 'text', text: 'end' },
      null
    ];

    test(xml, expect, done);
  });

  it('should handle splits', function(done) {
    // If we reach the end-of-buffer while parsing a text node we don't know if
    // we should continue, so we stop since there might be more data in the
    // buffer.

    var xml = ["<a>te", "st", "ing</", "a>end"];
    var expect = [
      { type: 'start', tag: 'a', attrs: {} },
      { type: 'text', text: 'testing' },
      { type: 'end', tag: 'a' },
      { type: 'text', text: 'end' },
      null
    ];

    test(xml, expect, done);
  });

});

describe('from string', function() {

  function test(xml, expect, done) {
    co(function*() {
      var parser = new xmls.Parser();

      parser.readString('xml', xml);

      var expected;
      for (var i = 0; i < expect.length; i++) {
        expected = expect[i];
        var got = yield parser.read();
        if (expected === null && got === null)
          break;
        assert.deepEqual(expected, got);
      }
      assert.equal(expected, null, 'Did not complete');

    }).then(function() {
      done();
    }, function(error) {
      done(error);
    });
  }

  it('should not choke on backslash', function(done) {
    var xml = '<e a="test\\">ing</e>';
    var expect = [
      { type: 'start', tag: 'e', attrs: { a: 'test\\' } },
      { type: 'text', text: 'ing' },
      { type: 'end', tag: 'e' },
      null
    ];

    test(xml, expect, done);
  });

  it('should handle quote refs', function(done) {
    var xml = '<e a="test&quot;ing"></e>';
    var expect = [
      { type: 'start', tag: 'e', attrs: { a: 'test"ing' } },
      { type: 'end', tag: 'e' },
      null
    ];

    test(xml, expect, done);
  });

  it('should allow text node at end', function(done) {

    var xml = "<a>testing</a>end";
    var expect = [
      { type: 'start', tag: 'a', attrs: {} },
      { type: 'text', text: 'testing' },
      { type: 'end', tag: 'a' },
      { type: 'text', text: 'end' },
      null
    ];

    test(xml, expect, done);
  });

  it('should parse from a string', function(done) {

    // This is from Wikipedia's SAX article.  I changed the numeric reference to
    // a normal ASCII character though.

    var xml = (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<DocumentElement param="value">' +
      '     <FirstElement>' +
      '         &#x30; Some Text' +
      '     </FirstElement>' +
      '     <?some_pi some_attr="some_value"?>' +
      '     <SecondElement param2="something">' +
      '         Pre-Text <Inline>Inlined text</Inline> Post-text.' +
      '     </SecondElement>' +
      '</DocumentElement>');

    var expect = [
      { type: 'start', tag: 'DocumentElement', attrs: { param: 'value' } },
      { type: 'text', text: '     ' },
      { type: 'start', tag: 'FirstElement', attrs: {} },
      { type: 'text', text: '         0 Some Text     ' },
      { type: 'end', tag: 'FirstElement' },
      { type: 'text', text: '     ' },
      // We eat the processing directive in this version.
      { type: 'text', text: '     ' },
      { type: 'start', tag: 'SecondElement', attrs: { param2: 'something' } },
      { type: 'text', text: '         Pre-Text ' },
      { type: 'start', tag: 'Inline', attrs: {} },
      { type: 'text', text: 'Inlined text' },
      { type: 'end', tag: 'Inline' },
      { type: 'text', text: ' Post-text.     ' },
      { type: 'end', tag: 'SecondElement' },
      { type: 'end', tag: 'DocumentElement' },
      null
    ];

    test(xml, expect, done);
  });

  it('should handle CDATA', function(done) {
    var xml = "<test>" +
        "<![CDATA[<sender>John Smith</sender>]]>" +
        "</test>";

    var expect = [
      { type: 'start', tag: 'test', attrs: {} },
      { type: 'cdata', data: '<sender>John Smith</sender>' },
      { type: 'end', tag: 'test'},
      null
    ];

    test(xml, expect, done);
  });
});
