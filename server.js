const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

const REFRESH_INTERVAL = 10_000;

// Roblox Charts yang kita gunakan.
// Semua data berasal dari Roblox.
const SORTS = [
	"top-playing-now",
	"top-trending",
	"up-and-coming",
];

// Maksimum game yang kita track.
// Bukan dummy — semuanya ditemukan dari Roblox Charts.
const MAX_GAMES = 100;

const ROBLOX_CHARTS =
	"https://apis.roblox.com/explore-api/v1/get-sort-content";

const ROBLOX_GAMES =
	"https://games.roblox.com/v1/games";

let snapshot = {
	totalPlayers: 0,

	mostPlayed: null,

	games: [],

	timestamp: 0,

	status: "starting",
};

let refreshing = false;

--------------------------------------------------
-- HTTP HELPER
--------------------------------------------------

async function fetchJSON(url) {

	const response = await fetch(url, {
		headers: {
			"Accept": "application/json",
			"User-Agent":
				"Roblox-Right-Now/1.0",
		},
	});

	if (!response.ok) {

		throw new Error(
			`HTTP ${response.status} - ${url}`
		);

	}

	return await response.json();
}

--------------------------------------------------
-- GET ROBLOX CHART
--------------------------------------------------

async function getChart(sortId) {

	const sessionId =
		crypto.randomUUID();

	const params =
		new URLSearchParams({

			sessionId: sessionId,

			sortId: sortId,

			device: "computer",

			country: "all",

		});

	const url =
		`${ROBLOX_CHARTS}?${params.toString()}`;

	return await fetchJSON(url);
}

--------------------------------------------------
-- EXTRACT CHART GAMES
--------------------------------------------------

function extractGames(chart) {

	if (!chart) {
		return [];
	}

	// Roblox chart response biasanya
	// menyediakan games array.
	if (Array.isArray(chart.games)) {
		return chart.games;
	}

	// fallback kalau struktur berubah
	if (Array.isArray(chart.data)) {
		return chart.data;
	}

	if (Array.isArray(chart.content)) {
		return chart.content;
	}

	if (Array.isArray(chart.items)) {
		return chart.items;
	}

	return [];
}

--------------------------------------------------
-- GET DISCOVERED GAME IDS
--------------------------------------------------

async function discoverGames() {

	const allGames = new Map();

	for (const sortId of SORTS) {

		try {

			const chart =
				await getChart(sortId);

			const games =
				extractGames(chart);

			for (const game of games) {

				const universeId =
					game.universeId ??
					game.id;

				if (!universeId) {
					continue;
				}

				const playerCount =
					Number(
						game.playerCount ??
						game.playing ??
						0
					);

				if (!allGames.has(
					String(universeId)
				)) {

					allGames.set(
						String(universeId),
						{
							universeId:
								String(
									universeId
								),

							playerCount:
								playerCount,

						}
					);

				}
			}

		} catch (error) {

			console.error(
				`[RRN] Chart error: ${sortId}`,
				error.message
			);

		}

	}

	return Array.from(
		allGames.values()
	).slice(0, MAX_GAMES);

}

--------------------------------------------------
-- GET GAME DETAILS
--------------------------------------------------

async function getGameDetails(
	universeIds
) {

	if (
		!universeIds ||
		universeIds.length === 0
	) {

		return [];

	}

	const results = [];

	// Roblox URL kita batch supaya
	// request tidak terlalu besar.
	const BATCH_SIZE = 50;

	for (
		let i = 0;
		i < universeIds.length;
		i += BATCH_SIZE
	) {

		const batch =
			universeIds.slice(
				i,
				i + BATCH_SIZE
			);

		const params =
			new URLSearchParams();

		params.set(
			"universeIds",
			batch.join(",")
		);

		const url =
			`${ROBLOX_GAMES}?${params.toString()}`;

		try {

			const data =
				await fetchJSON(url);

			if (
				Array.isArray(
					data.data
				)
			) {

				results.push(
					...data.data
				);

			}

		} catch (error) {

			console.error(
				"[RRN] Game details error:",
				error.message
			);

		}

	}

	return results;

}

--------------------------------------------------
-- BUILD REAL SNAPSHOT
--------------------------------------------------

async function buildSnapshot() {

	console.log(
		"[RRN] Discovering REAL Roblox games..."
	);

	--------------------------------------------------
	-- DISCOVER FROM ROBLOX CHARTS
	--------------------------------------------------

	const discovered =
		await discoverGames();

	console.log(
		`[RRN] Discovered ${discovered.length} games.`
	);

	if (discovered.length === 0) {

		throw new Error(
			"No games discovered from Roblox."
		);

	}

	--------------------------------------------------
	-- GET REAL DETAILS
	--------------------------------------------------

	const universeIds =
		discovered.map(
			game =>
				game.universeId
		);

	const details =
		await getGameDetails(
			universeIds
		);

	console.log(
		`[RRN] Received details for ${details.length} games.`
	);

	--------------------------------------------------
	-- CREATE MAP
	--------------------------------------------------

	const discoveredMap =
		new Map();

	for (const game of discovered) {

		discoveredMap.set(
			String(game.universeId),
			game
		);

	}

	--------------------------------------------------
	-- NORMALIZE
	--------------------------------------------------

	const games = [];

	for (const game of details) {

		const universeId =
			String(game.id);

		const discoveredGame =
			discoveredMap.get(
				universeId
			);

		const players =
			Number(
				game.playing ??
				discoveredGame?.playerCount ??
				0
			);

		// Skip invalid entries.
		if (!game.name) {
			continue;
		}

		if (!game.rootPlaceId) {
			continue;
		}

		games.push({

			name:
				String(game.name),

			players:
				players,

			placeId:
				game.rootPlaceId,

			universeId:
				game.id,

		});

	}

	--------------------------------------------------
	-- SORT BY PLAYER COUNT
	--------------------------------------------------

	games.sort(
		(a, b) =>
			b.players - a.players
	);

	--------------------------------------------------
	-- MOST PLAYED
	--------------------------------------------------

	const mostPlayed =
		games.length > 0
			? games[0]
			: null;

	--------------------------------------------------
	-- TRACKED PLAYERS
	--------------------------------------------------

	let totalPlayers = 0;

	for (const game of games) {

		totalPlayers +=
			game.players;

	}

	--------------------------------------------------
	-- SNAPSHOT
	--------------------------------------------------

	return {

		// IMPORTANT:
		// ini jumlah player dari game-game
		// yang berhasil kita track,
		// BUKAN klaim total seluruh Roblox.

		totalPlayers:
			totalPlayers,

		mostPlayed:
			mostPlayed
				? {

					name:
						mostPlayed.name,

					players:
						mostPlayed.players,

					placeId:
						mostPlayed.placeId,

					universeId:
						mostPlayed.universeId,

				}
				: null,

		games:
			games,

		timestamp:
			Math.floor(
				Date.now() / 1000
			),

		status:
			"live",

	};

}

--------------------------------------------------
-- REFRESH
--------------------------------------------------

async function refresh() {

	if (refreshing) {

		console.log(
			"[RRN] Refresh already running."
		);

		return;

	}

	refreshing = true;

	try {

		const newSnapshot =
			await buildSnapshot();

		snapshot =
			newSnapshot;

		console.log(
			"----------------------------------------"
		);

		console.log(
			"[RRN] REAL DATA UPDATED"
		);

		console.log(
			"[RRN] Games:",
			snapshot.games.length
		);

		console.log(
			"[RRN] Tracked Players:",
			snapshot.totalPlayers
		);

		if (
			snapshot.mostPlayed
		) {

			console.log(
				"[RRN] Most Played:",
				snapshot.mostPlayed.name,
				"|",
				snapshot.mostPlayed.players
			);

		}

		console.log(
			"[RRN] Timestamp:",
			snapshot.timestamp
		);

		console.log(
			"----------------------------------------"
		);

	} catch (error) {

		console.error(
			"[RRN] REFRESH FAILED:",
			error.message
		);

		// Jangan menghapus data terakhir
		// kalau refresh berikutnya gagal.

		snapshot = {

			...snapshot,

			status:
				"stale",

		};

	} finally {

		refreshing = false;

	}

}

--------------------------------------------------
-- API RESPONSE
--------------------------------------------------

function sendJSON(
	response,
	data
) {

	const body =
		JSON.stringify(data);

	response.writeHead(
		200,
		{
			"Content-Type":
				"application/json",

			"Access-Control-Allow-Origin":
				"*",

			"Cache-Control":
				"no-store",

		}
	);

	response.end(body);

}

--------------------------------------------------
-- HTTP SERVER
--------------------------------------------------

const server =
	http.createServer(
		(request, response) => {

			const url =
				new URL(
					request.url,
					`http://${request.headers.host}`
				);

			--------------------------------------------------
			-- HEALTH CHECK
			--------------------------------------------------

			if (
				url.pathname ===
				"/"
			) {

				sendJSON(
					response,
					{

						service:
							"ROBLOX RIGHT NOW",

						status:
							snapshot.status,

						timestamp:
							snapshot.timestamp,

					}
				);

				return;

			}

			--------------------------------------------------
			-- RRN ENDPOINT
			--------------------------------------------------

			if (
				url.pathname ===
				"/roblox-right-now"
			) {

				sendJSON(
					response,
					snapshot
				);

				return;

			}

			--------------------------------------------------
			-- NOT FOUND
			--------------------------------------------------

			response.writeHead(
				404,
				{
					"Content-Type":
						"application/json",
				}
			);

			response.end(
				JSON.stringify({
					error:
						"Not Found",
				})
			);

		}
	);

--------------------------------------------------
-- START SERVER
--------------------------------------------------

server.listen(
	PORT,
	() => {

		console.log(
			"========================================"
		);

		console.log(
			"ROBLOX RIGHT NOW BACKEND"
		);

		console.log(
			"Server running on port:",
			PORT
		);

		console.log(
			"Data source: REAL ROBLOX CHARTS"
		);

		console.log(
			"Refresh:",
			REFRESH_INTERVAL / 1000,
			"seconds"
		);

		console.log(
			"========================================"
		);

		// Ambil data pertama kali.
		refresh();

		// Refresh otomatis.
		setInterval(
			refresh,
			REFRESH_INTERVAL
		);

	}
);
