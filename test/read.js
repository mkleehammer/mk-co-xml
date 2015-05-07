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
    .parse(process.argv);

  if (program.args.length !== 1) {
    program.help();
    console.log('\Pass one and only one filename');
    process.exit(1);
  }

  var fqn = path.join(__dirname, program.args[0]);

  var reader = new Parser();
  reader.readFile(fqn);

  var count = 0;

  var got;
  while (true) {
    got = yield reader.read();
    if (!got)
      break;

    if (program.verbose === 1) {
      count += 1;
      if ((count % 100) === 0)
        console.log(count);
    } else if (program.verbose > 1) {
      console.log('%j', got);
    }
  }

  if (got !== undefined)
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
