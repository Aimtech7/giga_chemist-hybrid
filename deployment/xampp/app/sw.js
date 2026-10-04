/**
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// If the loader is already loaded, just stop.
if (!self.define) {
  let registry = {};

  // Used for `eval` and `importScripts` where we can't get script URL by other means.
  // In both cases, it's safe to use a global var because those functions are synchronous.
  let nextDefineUri;

  const singleRequire = (uri, parentUri) => {
    uri = new URL(uri + ".js", parentUri).href;
    return registry[uri] || (
      
        new Promise(resolve => {
          if ("document" in self) {
            const script = document.createElement("script");
            script.src = uri;
            script.onload = resolve;
            document.head.appendChild(script);
          } else {
            nextDefineUri = uri;
            importScripts(uri);
            resolve();
          }
        })
      
      .then(() => {
        let promise = registry[uri];
        if (!promise) {
          throw new Error(`Module ${uri} didn’t register its module`);
        }
        return promise;
      })
    );
  };

  self.define = (depsNames, factory) => {
    const uri = nextDefineUri || ("document" in self ? document.currentScript.src : "") || location.href;
    if (registry[uri]) {
      // Module is already loading or loaded.
      return;
    }
    let exports = {};
    const require = depUri => singleRequire(depUri, uri);
    const specialDeps = {
      module: { uri },
      exports,
      require
    };
    registry[uri] = Promise.all(depsNames.map(
      depName => specialDeps[depName] || require(depName)
    )).then(deps => {
      factory(...deps);
      return exports;
    });
  };
}
define(['./workbox-970124e6'], (function (workbox) { 'use strict';

  self.skipWaiting();
  workbox.clientsClaim();
  /**
   * The precacheAndRoute() method efficiently caches and responds to
   * requests for URLs in the manifest.
   * See https://goo.gl/S9QRab
   */
  workbox.precacheAndRoute([{
    "url": "registerSW.js",
    "revision": "402b66900e731ca748771b6fc5e7a068"
  }, {
    "url": "pwa-maskable-512x512.png",
    "revision": "045be7eb785f087b29118ff4f318f67f"
  }, {
    "url": "pwa-512x512.png",
    "revision": "a94c54e2b99a75647deb27ceec4cf7eb"
  }, {
    "url": "pwa-192x192.png",
    "revision": "d88a9c71cc5b9c2e623eb6f64c6c4ea9"
  }, {
    "url": "index.html",
    "revision": "8eab446278ec02bbfb8d1d3c4ee80068"
  }, {
    "url": "icon.svg",
    "revision": "dfd315cdf4687e0210748b589ec666f3"
  }, {
    "url": "favicon.ico",
    "revision": "52528a56e3842860367a40148569a934"
  }, {
    "url": "apple-touch-icon.png",
    "revision": "12c64734e580feadc1802118c3e76ff0"
  }, {
    "url": "assets/index-DZbNlLmd.js",
    "revision": null
  }, {
    "url": "assets/index-Byzy3JbW.css",
    "revision": null
  }, {
    "url": "apple-touch-icon.png",
    "revision": "12c64734e580feadc1802118c3e76ff0"
  }, {
    "url": "favicon.ico",
    "revision": "52528a56e3842860367a40148569a934"
  }, {
    "url": "icon.svg",
    "revision": "dfd315cdf4687e0210748b589ec666f3"
  }, {
    "url": "pwa-192x192.png",
    "revision": "d88a9c71cc5b9c2e623eb6f64c6c4ea9"
  }, {
    "url": "pwa-512x512.png",
    "revision": "a94c54e2b99a75647deb27ceec4cf7eb"
  }, {
    "url": "pwa-maskable-512x512.png",
    "revision": "045be7eb785f087b29118ff4f318f67f"
  }, {
    "url": "manifest.webmanifest",
    "revision": "26228e33f9d7cca365119d5181bf00ec"
  }], {});
  workbox.cleanupOutdatedCaches();
  workbox.registerRoute(new workbox.NavigationRoute(workbox.createHandlerBoundToURL("/index.html")));
  workbox.registerRoute(/^\/api\/.*/i, new workbox.NetworkFirst({
    "cacheName": "api-runtime-cache",
    "networkTimeoutSeconds": 3,
    plugins: [new workbox.ExpirationPlugin({
      maxEntries: 100,
      maxAgeSeconds: 86400
    }), new workbox.CacheableResponsePlugin({
      statuses: [0, 200]
    })]
  }), 'GET');

}));
