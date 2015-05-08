#!/usr/bin/env node --harmony

// A command line utility that simply reads an XML file.  Use to manually test
// the parser on different files.

'use strict';

var path = require('path');
var co = require('co');
var Parser = require('../index.js').Parser;

function* main() {
  var program = require('commander');
  program
    .version('1.0.0')
    .usage('[options] file')
    .option('-v --verbose', 'print more', increaseVerbosity, 0)
    .option('--max [max]', 'stop after max records', parseInt, 0)
    .parse(process.argv);

  var filename = program.args[0];
  if (program.args.length !== 1) {
    program.help();
    console.log('\Pass one and only one filename');
    process.exit(1);
  }

  var fqn = path.join(__dirname, filename);

  var reader = new Parser();
  reader.readFile(fqn);

  var count = 0;
  var maxCount = program.max || 9999999;

  var got;
  while (true) {
    got = yield reader.read();
    if (!got)
      break;

    count += 1;
    if (count > maxCount) {
      console.log('--max reached');
      break;
    }

    if (program.verbose === 1) {
      if ((count % 100) === 0)
        console.log(count);
    } else if (program.verbose > 1) {
      console.log('%j', got);
    }
  }

  if (got != null)
    console.log('Not complete!');
}

function increaseVerbosity(v, total) {
  return total + 1;
}

co(main)
  .then(function () { },
        function (err) {
          console.error(err.stack);
        });
