/**
 * dns-patch.js
 * Ensures DNS resolution works reliably by resolving via Google DNS & Cloudflare DNS
 * directly through dns.promises.Resolver, avoiding OS getaddrinfo bottlenecks or misconfigured DNS.
 * Falls back to the system resolver whenever the public DNS servers fail.
 */
const dns = require('dns');
const net = require('net');

try {
  const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4', '77.88.8.8']);

  // Game downloads hit the same few hosts thousands of times; resolving each request again is wasted time
  const DNS_TTL_MS = 60 * 1000;
  const answers = new Map(); // hostname -> { addrs, expires }

  const origLookup = dns.lookup;
  dns.lookup = function (hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    } else if (typeof options === 'number') {
      options = { family: options };
    }
    options = options || {};

    if (!hostname || hostname === 'localhost' || net.isIP(hostname) || options.family === 6) {
      return origLookup(hostname, options, callback);
    }

    const reply = (addrs) => {
      if (options.all) {
        callback(null, addrs.map(a => ({ address: a, family: 4 })));
      } else {
        callback(null, addrs[0], 4);
      }
    };

    const cached = answers.get(hostname);
    if (cached && cached.expires > Date.now()) {
      process.nextTick(reply, cached.addrs);
      return;
    }

    resolver.resolve4(hostname).then(addrs => {
      if (!addrs || !addrs.length) {
        return origLookup(hostname, options, callback);
      }
      answers.set(hostname, { addrs, expires: Date.now() + DNS_TTL_MS });
      if (options.all) {
        callback(null, addrs.map(a => ({ address: a, family: 4 })));
      } else {
        callback(null, addrs[0], 4);
      }
    }).catch(() => {
      origLookup(hostname, options, callback);
    });
  };

  dns.setDefaultResultOrder && dns.setDefaultResultOrder('ipv4first');
} catch (e) {
  console.warn('[DNS-Patch] Warning initializing DNS patch:', e.message);
}
