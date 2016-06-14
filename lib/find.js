
var async = require("async"),
	_ = require("lodash"),
	OS = require("opensubtitles-api");

var OpenSubtitles = new OS("NodeOpensubtitles v0.0.1");

var LANG_MAP = {
	"albanian":"sqi","arabic":"ara","bengali":"ben","bulgarian":"bul","bosnian":"bos","chinese":"zho","croatian":"hrv","czech":"cze",
	"danish":"dan","dutch":"nld","english":"eng","estonian":"est","farsi-persian":"per","finnish":"fin","french":"fre","german":"ger",
	"greek":"gre","hebrew":"heb","hungarian":"hun","indonesian":"ind","italian":"ita","japanese":"jpn","korean":"kor","lithuanian":"lit",
	"macedonian":"mkd","malay":"msa","norwegian":"nor","polish":"pol","portuguese":"por","romanian":"rum","russian":"rus","serbian":"srp",
	"slovenian":"slv","spanish":"spa","swedish":"swe","thai":"tha","turkish":"tur","urdu":"urd","ukrainian":"ukr","vietnamese":"vie", "brazilian-portuguese": "por"
};

function debugLog()
{
	//optimist.argv["subtitles-crawler-debug"] && console.log.apply(console, arguments)
	console.log.apply(console, arguments);

};


/* Exported functions
 * findSubtitles - can take anything from 600ms to 3000ms
 */
function findSubtitles(args, callback)
{
	var query = args || { }; // for now
	
	// new format 
	if (args.query) {
		if (! args.query.itemHash) return callback({ code: 12, message: "query.itemHash required" });

		query.hash = args.query.itemHash;
		var split = args.query.itemHash.split(" ");
		query.meta = split.length > 1 ? { imdb_id: split[0], season: parseInt(split[1]), episode: parseInt(split[2]) } : { imdb_id: split[0] };
		if (args.query.videoHash) query.movieHash = args.query.videoHash;
		if (args.query.videoSize) query.movieByteSize = args.query.videoSize.toString();
		if (args.query.videoName) query.tag = args.query.videoName;
	}

	if (! query.hash) return callback({ code: 10, message: "findSubtitles requires hash" });
	if (! (query.meta && query.meta.imdb_id)) return callback({ code: 11, message: "findSubtitles requires item metadata (imdb_id, ?season, ?episode)" });

	var callback = _.once(callback);

	var subtitles = null; // Subtitles object in DB
	var langs = null; // All languages

	debugLog("subtitles-crawler: retrieving subtitles for "+query.hash);

	/* 
	 *  If the results are there, return them early, but continue with making the request; 
	 *  UNLESS we have made the same request in the last 60 min
	 */
	async.auto({
		subtitles: function(cb, res) { // Get the subtitles object in the DB
			setTimeout(function() {
				if (! subtitles) debugLog("subtitles-crawler: subtitles for - "+query.hash+" internal timeout - completed: "+(res && Object.keys(res).join(", "))+" subtitles is: "+JSON.stringify(subtitles));
			}, 15000);

			subtitles = { 
				blacklisted: []
			};
			return cb();

		},
		retrieve: ["subtitles", function(cb, res) {

			OpenSubtitles.login().then( function(token) {
				OpenSubtitles.search({
					sublanguageid: 'all',
					hash: query.movieHash || null,
					filesize: query.movieByteSize || null,
					filename: query.tag || null,
					extensions: ['srt', 'vtt'],
					limit: 'best',
					imdbid: query.meta && query.meta.imdb_id ? query.meta.imdb_id : null,
					season: query.meta && query.meta.season ? query.meta.season : null,
					episode: query.meta && query.meta.episode ? query.meta.episode : null
				}).then(function (subtitles) {
					var langRes = {};
					_.each( subtitles, function(el) {
						var iso6391 = LANG_MAP[el.langName.toLowerCase()];
						langRes[iso6391] = [{
							id: el.id,
							url: el.url.replace('/filead/', '/subencoding-utf8/filead/') + '.gz',
							lang: iso6391
						}];
					});

					callback(null, {
						subtitles: langRes,
						item_hash: query.item_hash,
						id: query.item_hash.split(' ').join('-')
					});
		
				});
			});

		}]
	}, function(err) {
		if (err && err!==true) { console.error("findSubtitles", err); return callback(null, subtitles) };

		if (err === true) {
			debugLog("subtitles-crawler: subtitles for "+query.hash+" are fresh, not scraped");
		}

		callback(null, subtitles);
	});
};

module.exports = findSubtitles;
