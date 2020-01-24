const fs = require('fs').promises;
const path = require('path');

module.exports.getUrls = async function(file) {
    let content = await fs.readFile(file, 'utf8');
    content = content.replace(/\r\n/, '\n').replace(/\r/, '\n');
    let urls = content.split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line[0] != '#');
    return urls;
};

module.exports.getCmpRules = async function(dir) {
    let rules = [];
    let filenames = await fs.readdir(dir);
    filenames.sort();

    for (let filename of filenames) {
        if (!filename.startsWith('__') && filename.endsWith('.js')) {
            let rule = require(path.join(dir, filename));
            rules.push(rule);
        }
    }
    return rules;
};