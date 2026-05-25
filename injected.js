// Page-context shim. Wraps window.fetch + XMLHttpRequest so we can read the
// JSON responses Pinterest's own SPA loads while the user browses, and
// forwards them to the content script via postMessage.

(function () {
  const TAG = "pinreel-capture";

  function forward(data) {
    try {
      window.postMessage({ source: TAG, payload: data }, "*");
    } catch {
      /* ignore */
    }
  }

  function isInterestingUrl(url) {
    if (typeof url !== "string") return false;
    let resolved = url;
    try {
      resolved = new URL(url, window.location.origin).toString();
    } catch {
      /* keep raw */
    }
    if (!resolved.includes("pinterest.com")) return false;
    return (
      resolved.includes("/resource/") ||
      resolved.includes("/api/") ||
      resolved.includes("PinResource") ||
      resolved.includes("BoardFeedResource")
    );
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    const p = origFetch.apply(this, args);
    if (isInterestingUrl(url)) {
      p.then((res) => {
        res
          .clone()
          .text()
          .then((text) => {
            try {
              forward(JSON.parse(text));
            } catch {
              /* not json */
            }
          })
          .catch(() => {});
      }).catch(() => {});
    }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__pinreelUrl = typeof url === "string" ? url : "";
    return origOpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      if (!isInterestingUrl(this.__pinreelUrl)) return;
      try {
        if (this.responseType === "" || this.responseType === "text") {
          const text = this.responseText;
          if (text) {
            try {
              forward(JSON.parse(text));
            } catch {
              /* ignore */
            }
          }
        } else if (this.responseType === "json") {
          if (this.response) forward(this.response);
        }
      } catch {
        /* ignore */
      }
    });
    return origSend.apply(this, args);
  };

  function dumpGlobals() {
    try {
      const pws = window.__PWS_DATA__ || window.__PWS_INITIAL_PROPS__;
      if (pws) forward(pws);
    } catch {
      /* ignore */
    }
  }
  dumpGlobals();
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source === "pinreel-scan-request") dumpGlobals();
  });
})();
