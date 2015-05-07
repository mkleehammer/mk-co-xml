
var assert = require("assert");

var xmls = require('../index.js');
var co = require('co');

// describe('interactive', function() {
//   // This is just used for interative testing and is not part of the test suite.
//   it.only('should parse this file too!', function(done) {
//     var path = require('path');
//
//     co(function*() {
//       var parser = new xmls.Parser();
//
//       parser.readFile(path.join(__dirname, '../tmp/test.xml'));
//
//       var got;
//       for (var i = 0; i < 300; i++) {
//         got = yield parser.read();
//         if (got === undefined)
//           break;
//         console.log('%j', got);
//       }
//
//       if (got !== undefined)
//         console.log('Not complete!');
//
//     }).then(function() {
//       done();
//     }, function(error) {
//       done(error);
//     });
//   });
// });

describe('basic', function() {
  it('should parse from a string', function(done) {

    // This is from Wikipedia's SAX article.  I changed the numeric reference to
    // a normal ASCII character though.

    var saxExample = (
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

    var results = [
      { type: 'elementStart', tag: 'DocumentElement', attributes: { param: 'value' } },
      { type: 'text', text: '     ' },
      { type: 'elementStart', tag: 'FirstElement', attributes: {} },
      { type: 'text', text: '         0 Some Text     ' },
      { type: 'elementEnd', tag: 'FirstElement' },
      { type: 'text', text: '     ' },
      // We eat the processing directive in this version.
      { type: 'text', text: '     ' },
      { type: 'elementStart', tag: 'SecondElement', attributes: { param2: 'something' } },
      { type: 'text', text: '         Pre-Text ' },
      { type: 'elementStart', tag: 'Inline', attributes: {} },
      { type: 'text', text: 'Inlined text' },
      { type: 'elementEnd', tag: 'Inline' },
      { type: 'text', text: ' Post-text.     ' },
      { type: 'elementEnd', tag: 'SecondElement' },
      { type: 'elementEnd', tag: 'DocumentElement' },
      undefined
    ];

    co(function*() {
      var parser = new xmls.Parser();

      parser.readString('SAX-Example', saxExample);

      var expected;
      for (var i = 0; i < results.length; i++) {
        expected = results[i];

        var got = yield parser.read();

        if (expected === undefined && got === undefined)
          break;

        assert.deepEqual(expected, got);
      }
      assert.equal(expected, undefined, 'Did not complete');

    }).then(function() {
      done();
    }, function(error) {
      done(error);
    });
  });
});
