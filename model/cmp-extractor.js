const {default: PQueue} = require('p-queue');
const PageAnalyzer = require('./page-analyzer');
const uniqid = require('uniqid');
const filenamifyUrl = require('filenamify-url');
const EventEmitter = require('events').EventEmitter;
const _ = require('lodash');
const fs = require('fs').promises;
const path = require('path');
const errors = require('./error');
const puppeteer = require('puppeteer');
const fkill = require('fkill');
const config = require('./config');

const DEFAULT_OPTIONS = Object.freeze({
    takeScreenshot: false,
    useIdForScreenshotName: false,
    maxConcurrency: 25,
    createNewDirForEachRun: true,
    pageTimeoutMs: 60000
});

class CmpExtractor {

    constructor(urls, cmpRules, destDir, options = {}) {
        options = _.defaults(options, DEFAULT_OPTIONS);
        this._urls = urls;
        this._cmpRules = cmpRules;
        let dataDirName = 'cmp-data-' + (options.createNewDirForEachRun ? getDateTimeDirString() : '');
        this._destDir = path.join(destDir, dataDirName);
        this._takeScreenshot = options.takeScreenshot;
        this._useIdForScreenshotName = options.useIdForScreenshotName;
        this._maxConcurrency = options.maxConcurrency;
        this._pageTimeout = options.pageTimeoutMs;
        this._queue = new PQueue({concurrency: this._maxConcurrency});
        this._eventEmitter = new EventEmitter();
        this._progression = {total: urls.length, completed: 0, failed: 0, pending: urls.length};
    }

    addProgressionListener(listener) {
        this._eventEmitter.addListener('progression', listener);
    }

    removeProgressionListener(listener) {
        this._eventEmitter.removeListener('progression', listener);
    }

    async execute() {
        // mkdir if not exists
        await fs.mkdir(this._destDir, {recursive: true});
        if (this._takeScreenshot) {
            await fs.mkdir(path.join(this._destDir, 'screenshots'), {recursive: true});
        }

        // open files
        this._cmpDataFile = await fs.open(path.join(this._destDir, 'cmp-data.json'), 'a');
        this._cmpNotFoundUrlFile = await fs.open(path.join(this._destDir, 'cmp-not-found-urls.txt'), 'a');
        this._errorLogFile = await fs.open(path.join(this._destDir, 'errors.json'), 'a');

        this._emitProgression();

        for (let i = 0; i < this._urls.length; i++) {
            this._queue.add(async () => {
                await this._runAnalysis(this._urls[i]);
            });

            if (i % this._maxConcurrency === 0) {
                await this._queue.onEmpty();
            }

            if (i === 200) {
                await this._queue.onIdle();
                await this._reloadBrowser(); // prevent to large memory leaks from Chromium
            }
        }

        await this._queue.onIdle();

        //close files
        for (let fileDs of [this._cmpDataFile, this._cmpNotFoundUrlFile, this._errorLogFile]) {
            try {
                await fileDs.close();
            } catch (e) {
                console.error('Could not close file: ', e);
            }
        }

        await this._close();

    }

    async _reloadBrowser() {
        await this._close();
        await this._browserInstance();
    }

    async _close() {
        if (!this._browser) {
            return;
        }

        let browser = await this._browserInstance();
        let pid = browser.process().pid;
        await browser.close();
        await fkill(pid, {
            force: true,
            tree: true,
            silent: true
        });
    }

    async _runAnalysis(url) {
        try {
            let analyzer = new PageAnalyzer(url, this._cmpRules, this._pageTimeout);
            let id = uniqid();

            let screenshotInfo = undefined;
            if (this._takeScreenshot) {
                screenshotInfo = {
                    dirPath: path.join(this._destDir, 'screenshots'),
                    imageName: this._useIdForScreenshotName ? id : filenamifyUrl(url)
                };
            }

            let browser = await this._browserInstance();
            let res = await analyzer.extractCmpData(browser, screenshotInfo);

            if (!res.data || _.isEmpty(res.data)) {
                await this._cmpNotFoundUrlFile.appendFile(url + '\n', 'utf8');
            } else {
                let entry = {
                    url: url,
                    cmpName: res.cmpName,
                    data: res.data
                };

                if (this._useIdForScreenshotName) {
                    entry.id = id;
                }

                let json = JSON.stringify(entry);
                await this._cmpDataFile.appendFile(json + '\n', 'utf8');
            }

            this._progression.completed++;
        } catch (e) {
            this._progression.failed++;
            if (config.debug) {
                console.error(e);
            }
            let error = {
                url: url
            };
            if (e instanceof errors.HttpError) {
                error.errorType = 'http';
                error.error = e.statusCode;
            } else {
                error.errorType = 'internal';
                error.error = e.toString();
                error.stack = e.stack;
            }
            let json = JSON.stringify(error) + '\n';
            await this._errorLogFile.appendFile(json);
        } finally {
            this._progression.pending--;
            this._emitProgression();
        }
    }

    _emitProgression() {
        this._eventEmitter.emit('progression', _.clone(this._progression));
    }

    async _browserInstance() {
        if (!this._browser) {
            this._browser = await puppeteer.launch({headless: true, defaultViewport: {width: 1024, height: 1024},
                args: []});
            this._browser.on('disconnected', () => this._browser = null);
        }
        return this._browser;
    }

}

function getDateTimeDirString() {
    let now = new Date();
    return `${now.getFullYear()}-${padDatePart(now.getMonth() + 1)}-${padDatePart(now.getDate())}`
        + `T${padDatePart(now.getHours())}_${padDatePart(now.getMinutes())}_${padDatePart(now.getSeconds())}`;
}

function padDatePart(part) {
    return `${part}`.padStart(2, '0');
}


module.exports = CmpExtractor;