var addons = require("stremio-addons");
var http = require("http");
var _ = require("underscore");
var moment = require("moment");
var url = require("url");

/* Clusterify */
var cluster = require('cluster');
if (process.env.WEB_CONCURRENCY && cluster.isMaster) {
	var numCPUs = process.env.WEB_CONCURRENCY || require('os').cpus().length;

	for (var i = 0; i < numCPUs; i++) { cluster.fork() }
	
	cluster.on("exit", function(worker) {
		console.log("worker %s died, restarting in 5s", worker.process.pid); 
		setTimeout(function() { cluster.fork() }, 5*1000);
	});

	return;
}

/* Basic glue
 */
var find = require("./lib/find");
var tracks = require("./lib/tracks");
var hash = require("./lib/hash");


if (process.env.REDIS) {
	// In redis
	console.log("Using redis caching");

	var redis = require("redis");
	red = redis.createClient(process.env.REDIS);
	red.on("error", function(err) { console.error("redis err",err) });

	cacheGet = function (domain, key, cb) { 
		red.get(domain+":"+key, function(err, res) { 
			if (err) return cb(err);
			if (process.env.CACHING_LOG) console.log("cache on "+domain+":"+key+": "+(res ? "HIT" : "MISS"));
			if (!res) return cb(null, null);
			try { cb(null, JSON.parse(res)) } catch(e) { cb(e) }
		});
	};
	cacheSet = function (domain, key, value, ttl) {
		var k = domain+":"+key
		if (ttl) red.setex(k, ttl/1000, JSON.stringify(value), function(e) { if (e) console.error(e) });
		else red.set(k, JSON.stringify(value), function(e) { if (e) console.error(e) });
	}
} else {
	// In memory
	cacheGet = function (domain, key, cb) { cb(null, null) }
	cacheSet = function(domain, key, value, ttl) { }
}

// WARNING: Unfortunately we have to cache in the old format, as app requires it
function subsGetCached(args, cb) {
	if (! args.query) return cb({ code: 13, message: "query required" });

	var id = args.query.videoHash || args.query.itemHash || args.query.item_hash; // item_hash is the obsolete property

	cacheGet("subtitles-find", id, function(err, subs) {
		if (err) console.error(err);
		if (subs) return cb(null, subs);

		find(args, function(err, res) {
			if (err || !res) return cb(err, res);

			// Do not serve .zip subtitles unless we explicitly allow it
			var count = 0;
			_.each(res.subtitles, function(group, key) { count += group.length });

			var ttlHours = count < 10 ? 12 : (count < 40 ? 24 : 7*24 )
			cacheSet("subtitles-find", id, res, ttlHours * 60 * 60 * 1000)

			if (!args.supportsZip) _.each(res.subtitles, function(group, key) {
				res.subtitles[key] = group.filter(function(sub) { return sub.url && !sub.url.match("zip$") });
			});

			cb(err, res);
		});
	});
}

function subsFind(args, cb) {
	if (! args.query) return cb({ code: 13, message: "query required" });

	var id = args.query.videoHash || args.query.itemHash || args.query.item_hash; // item_hash is the obsolete property

	subsGetCached(args, function(err, res) {
		if (err) return cb(err);
		if (! (res && res.subtitles)) return cb(null, { id: id, all: [] });

		var all = _.chain(res.subtitles).map(function(list, lang) { 
			return (Array.isArray(list) ? list : []).map(function(x) {
				x.lang = lang;
				return x;
			});
		}).flatten().value();

		var res = { id: id, all: all };
		cb(null, res)
	});
}

var service = new addons.Server({
	"subtitles.get": subsGetCached,
	"subtitles.find": subsFind,
	"subtitles.tracks": tracks,
	"subtitles.hash": hash,
	"stats.get": function(args, cb, user) {

		var pkg = require("./package"); 
		cb(null, { name: pkg.name, version: pkg.version, stats: [{name: "subtitles", colour:"green"}], statsNum: "~ 3000000 subtitle files" });
	}
},  { stremioget: true, allow: ["http://api9.strem.io"] }, require("./stremio-manifest"));

service.proxySrtOrVtt = function(req, res) {
	// req.params.delay
	var isVtt = req.params.ext === "vtt"; // we can set it to false for srt
	var query = url.parse(req.url, true).query;
	var offset = query.offset ? parseInt(query.offset) : null;
	service.request("subtitles.tracks", [{ stremioget: true }, { url: query.from }], function(err, handle) {
		if (err) {
			console.error(err);
			res.writeHead(500);
			res.end();
			return;
		}
		if (isVtt) res.write("WEBVTT\n\n");
		var format = function(d) {
			return isVtt ? moment(d).utcOffset(0).format("HH:mm:ss.SSS") : moment(d).utcOffset(0).format("HH:mm:ss,SSS")
		};
		var applOffset = offset ? function(d) { return new Date(new Date(d).getTime() + offset) } : function(d) { return new Date(d); };
		handle.tracks.forEach(function(track, i) {
			res.write(i.toString()+"\n");
			res.write(format(applOffset(track.startTime)) + " --> " + format(applOffset(track.endTime)) +"\n");
			res.write(track.text.replace(/&/g, "&amp;")+"\n\n"); // TODO: sanitize?
		});
		res.end();
	});
}
module.exports = service;

/* Init server
 */
if (module.parent) { module.exports = service; } else {
	var server = http.createServer(function (req, res) {
	  service.middleware(req, res, function() { res.end() });
	}).listen(process.env.PORT || 3011).on("listening", function()
	{
		console.log("Subtitles listening on "+server.address().port);
	});	
}
