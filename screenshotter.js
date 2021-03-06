const puppeteer = require('puppeteer');
const express = require('express');
const morgan = require('morgan');
const fp = require("find-free-port");
const c = require('ansi-colors');
const log = require('fancy-log');
const {TimeoutError} = require('puppeteer/Errors');
const timeout = ms => new Promise(res => setTimeout(res, ms));
var pjson = require('./package.json');
console.log(c.yellow(`Running ${pjson.name} ${pjson.version}`));

// Default is 5
const http = require('http');
http.globalAgent.maxSockets = 100;

const MAX_PUPPETEER_TIMEOUT = 60000;

function Screenshotter(options) {
    const defaults = {
        fullPage: false,
        url: "https://cloudcannon.com",
        requestFilters: null, // ['www.googletagmanager.com', 'www.google-analytics.com', 'www.youtube.com']
        logServerCalls: false,
        base64: false,
        docker: false,
        delay: 300,
        path: ".",
        portInc: 0
    }

    this.options = Object.assign({}, defaults, options);
}

Screenshotter.prototype.launchBrowser = async function () {
    let options = {};
    if (this.options.docker) {
        options.executablePath = 'google-chrome-unstable';
        options.args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ];
    }

    if (process.env.BROWSER) {
        this.browser = await puppeteer.connect({ browserWSEndpoint: process.env.BROWSER });
    } else {
        this.browser = await puppeteer.launch(options);
    }

    return this.browser;
}

Screenshotter.prototype.launchServer = async function (path, portInc) {
    if (!path) {
      path = this.options.path;
    }

    if (!portInc) {
      portInc = this.options.portInc;
    }

    if (this.server) {
        const port = this.server.address().port;
        return `http://${process.env.DOMAIN||"localhost"}:${port}`
    }

    process.stdout.write(c.yellow('Launching webserver...'));
    this.expressApp = express();

    process.stdout.write(c.yellow('.'));
    let [port] = await fp(5000);
    port += portInc;

    if (this.options.logServerCalls) {
      this.expressApp.use(morgan('tiny'));
    }
    this.expressApp.use(express.static(path));
    process.stdout.write(c.yellow('.\n'));

    this.server = await this.expressApp.listen(port);
    log(c.greenBright(`Done ✓`));

    return `http://${process.env.DOMAIN||"localhost"}:${port}`;
}

Screenshotter.prototype.loadPage = async function(serverUrl, url, screenSize) {
    let requestUrl = (serverUrl + "/" + url).replace(/\//g, "/");

    log(`Loading ${url} on ${screenSize.name}`);
    log('Launching page');

    const page = await this.browser.newPage();

    log('Setting up page');
    await page.emulateMedia('screen');
    await page.setUserAgent('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Safari/537.36');
    await page.setViewport({
        width: screenSize.width,
        height: screenSize.height
    });

    const filters = this.options.requestFilters;
    if (filters) {
      await page.setRequestInterception(true);
      function interceptRequests(interceptedRequest) {
        const url = interceptedRequest.url();
        const shouldAbort = filters.some((urlPart) => url.includes(urlPart));
        if (shouldAbort) {
          log(c.yellow('Request blocked: ') + url);
          interceptedRequest.abort();
        } else {
          log(c.blue('Request started: ') + url);
          interceptedRequest.continue();
        }
      }

      page.on('request', interceptRequests);
    }

    log(`Navigating to ${requestUrl}`);

    var successful = false;
    try {
      await page.goto(requestUrl, {timeout: 60000, waitUntil: 'load'});
      log(`Navigated to ${page.url()}`);
      await page._client.send('Animation.setPlaybackRate', { playbackRate: 20 });
      log(`Animation playback rate set to 20x on ${page.url()}`);
      successful = true;
    } catch (e) {
      if (e instanceof TimeoutError) {
        log(`Navigation timed out on ${page.url()}`);
      } else {
        log(`Navigation failed on ${page.url()}`);
        log.error(e);
      }
    }

    if (filters) {
      page.removeListener('request', interceptRequests)
    }
    return successful ? page : null;
}

Screenshotter.prototype.takeScreenshot = async function (page) {
    if (this.options.delay) {
      log(`Waiting ${this.options.delay}ms`);
      await timeout(this.options.delay);
    }

    let screenshotOptions = {encoding: (this.options.base64 ? "base64" : "binary")};

    log(`Finding page size`);
    const { width, height } = await page.evaluate(() => {
        const body = document.querySelector('body');
        const boundingBox = body.getBoundingClientRect();
        return {width: boundingBox.width, height: boundingBox.height};
    }).catch(e => log.error(e));

    if (this.options.fullPage) {
        screenshotOptions.clip = {
            x: 0,
            y: 0,
            width,
            height
        };
    }

    log(`Taking screenshot at ${width}px by ${height}px`);
    const screenshot = await page.screenshot(screenshotOptions);

    log(c.greenBright(`Screenshot completed ${page.url()} ✓`));

    log(`Page closing`);
    await page.close();
    log(`Page closed`);

    return screenshot;
}

Screenshotter.prototype.shutdownBrowser = async function () {
    await this.browser.close();
    this.browser = null;
}

Screenshotter.prototype.shutdownServer = async function () {
    await this.server.close();
    this.server = null;
}

module.exports = Screenshotter;
