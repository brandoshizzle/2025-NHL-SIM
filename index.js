const fs = require('fs');
const path = require('path');
const parse = require('csv-parse/sync').parse;

// Helper to load and parse a CSV file
function loadCSV (filename) {
	const content = fs.readFileSync(path.join(__dirname, filename), 'utf8');
	return parse(content, { columns: true });
}

// Load data
const schedule = loadCSV('schedule.csv');
const skaters = loadCSV('skaters.csv');
const goalies = loadCSV('goalies.csv');
// Load goalsperminute.json
const gpm = JSON.parse(fs.readFileSync(path.join(__dirname, 'goalsperminute.json'), 'utf8'));
const injuryOptions = JSON.parse(fs.readFileSync(path.join(__dirname, 'injuries.json'), 'utf8'));

let skaters_new = [];
let goalies_new = [];

// Build weighted array for random minute selection
const gpmWeighted = [];
Object.entries(gpm).forEach(([minute, count]) => {
	const min = Number(minute) - 1;
	if (min >= 0 && min < 60) {
		for (let i = 0; i < count; i++) gpmWeighted.push(min);
	}
});

function pickGoalMinute () {
	return gpmWeighted[Math.floor(Math.random() * gpmWeighted.length)];
}

// Remove duplicate games by gameId
const seenGameIds = new Set();
const uniqueSchedule = schedule.filter(game => {
	const id = game.gameId || game.GameId || game.id;
	if (!id || seenGameIds.has(id)) return false;
	seenGameIds.add(id);
	return true;
});

const sortedSchedule = uniqueSchedule.sort((a, b) => {
	const dateA = new Date(a.date || a.Date || a.gameDate);
	const dateB = new Date(b.date || b.Date || b.gameDate);
	return dateA - dateB;
});

// Group skaters and goalies by team, and initialize injury status
function groupByTeam (players, minGames = 0, key = 'team') {
	return players
		// Only include players with situation "all"
		.filter(p => (p.situation || p.Situation || '').toLowerCase() === 'all')
		// Check for players that are on multiple teams (traded mid-season)
		// .filter(p => !((p.team || p.Team || '').includes('/') || (p.team || p.Team || '').includes('\\')))
		// Only include players with more than 20 games_played
		.filter(p => Number(p.games_played || 0) > minGames)
		.map(p => {
			// Injury system: initialize status and risk
			const gamesLast = Number(p.games_played || 0);
			// Risk: missing games last year / 82,
			const risk = Math.min(1, Math.max(0.01, (82 - gamesLast) / 9 / 82));
			return {
				...p,
				injuryStatus: 'healthy',
				injuryGamesLeft: 0,
				injuryRisk: risk
			};
		})
		.reduce((acc, p) => {
			if (!acc[p[key]]) acc[p[key]] = [];
			acc[p[key]].push(p);
			return acc;
		}, {});
}

const skatersByTeam = groupByTeam(skaters, 20);
const goaliesByTeam = groupByTeam(goalies, 5);

function pickAssists (skaters, scorer) {
	// Pick up to 2 assists from teammates, excluding the scorer, based on their assist rates
	const potentialAssisters = skaters.filter(s => s.name !== scorer.name && (s.position !== scorer.position || scorer.position === "D"));

	const assists = [];
	if (potentialAssisters.length === 0) return assists;

	const numAssists = Math.floor(Math.random() * 3);
	for (let i = 0; i < numAssists; i++) {
		// Weighted random pick based on assist rates
		// Use primary assists if first one, secondary assists if second
		const assistProperty = i === 0 ? "I_F_primaryAssists" : "I_F_secondaryAssists";
		const totalWeight = potentialAssisters.reduce((sum, s) => sum + (Number(s[assistProperty] || 0)), 0);
		let rand = Math.random() * totalWeight;
		for (const s of potentialAssisters) {
			rand -= (s.I_F_primaryAssists || 0);
			if (rand <= 0) {
				assists.push(s.name);
				break;
			}
		}
	}
	return assists
}


// Estimate goals for a team based on skater shots and opponent goalie save percentage
function goalEstimator (teamSkaters, opponentGoalie) {
	// Average save percentage for opponent goalies: 1 - (goals / unblocked_shot_attempts)
	// Use OnIce_A_goals and OnIce_A_unblockedShotAttempts if available, else fallback
	let avgSavePct = 0.9;
	if (opponentGoalie) {
		const goals = Number(opponentGoalie.goals || 0);
		const unblocked = Number(opponentGoalie.unblocked_shot_attempts || 0);
		if (unblocked > 0) {
			avgSavePct = 1 - (goals / unblocked);
		}
	}

	// For each skater, estimate their shots, goals, assists in this game, and handle injuries
	const playerResults = teamSkaters.map(s => {
		// If player is injured, decrement games left and skip
		if (s.injuryStatus === 'injured') {
			s.injuryGamesLeft = (s.injuryGamesLeft || 0) - 1;
			if (s.injuryGamesLeft <= 0) {
				s.injuryStatus = 'healthy';
				s.injuryGamesLeft = 0;
			}
			return {
				name: s.name,
				team: s.team,
				position: s.position,
				shots: 0,
				goals: [],
				assists: [],
				hits: 0,
				injuryStatus: 'injured',
				injuryGamesLeft: s.injuryGamesLeft,
				injuredThisGame: false
			};
		}
		// Only healthy players participate
		const gamesPlayed = Number(s.games_played || 1);

		// Hits: average per game with 20% randomness
		const avgHits = Number(s.I_F_hits || 0) / gamesPlayed;
		const hits = Math.max(0, Math.round(avgHits * (1 + (Math.random() * 0.4 - 0.2))));

		// Blocks: average per game with 20% randomness
		const avgBlocks = Number(s.shotsBlockedByPlayer || 0) / gamesPlayed;
		const blocks = Math.max(0, Math.round(avgBlocks * (1 + (Math.random() * 0.4 - 0.2))));

		// Shots / goals: based on player's shooting rate and opponent goalie save percentage
		const avgShots = Number(s.I_F_shotsOnGoal || 0) / gamesPlayed;
		const avgGoals = Number(s.I_F_goals || 0) / gamesPlayed;
		const shots = Math.max(0, Math.round(avgShots + (Math.random() * 2 - 1) - 0.25));
		let goals = [];
		const goalPerShot = avgShots > 0 ? avgGoals / avgShots : 0;
		for (let i = 0; i < shots; i++) {
			const shotChance = (1 - avgSavePct) * 0.3 + goalPerShot * 0.7 + 0.02;
			if (Math.random() < shotChance) {
				const randomSeconds = Math.floor(Math.random() * 60);
				goals.push({
					time: pickGoalMinute() + `:${randomSeconds < 10 ? "0" : ""}${randomSeconds}`,
					name: s.name,
					assists: pickAssists(teamSkaters, s)
				});
			}
		}
		// Simulate assists: proportional to goals, using player's assist rate
		// Each goal gets up to 2 assists, distributed among teammates
		// We'll estimate assists for this player as: (player's avg assists per game / team total avg assists per game) * team goals
		// For simplicity, here: assists = Math.round(goals * (avgAssists / (avgGoals + 0.01)))
		// let assists = 0;
		// if (avgGoals > 0) {
		//     assists = Math.round(goals * (avgAssists / avgGoals));
		// }
		// Injury check: each game, player can get injured
		let injuredThisGame = false;
		if (Math.random() < s.injuryRisk) {
			s.injuryStatus = 'injured';
			const injury = injuryOptions[Math.floor(Math.random() * injuryOptions.length)];
			s.injuryName = injury.name;
			s.injuryGamesLeft = injury.minGames + Math.floor(Math.random() * (injury.maxGames - injury.minGames + 1)); // random between min and max
			injuredThisGame = true;
		}
		return {
			name: s.name,
			team: s.team,
			position: s.position,
			shots,
			goals,
			hits,
			blocks,
			injuryName: s.injuryName,
			injuryStatus: s.injuryStatus,
			injuryGamesLeft: s.injuryGamesLeft,
			injuredThisGame
		};
	}); // closes teamSkaters.map
	// The rest of the function continues as before

	const totalShots = playerResults.reduce((sum, p) => sum + p.shots, 0);
	const estimatedGoals = playerResults.reduce((sum, p) => sum + p.goals.length, 0);
	const playerAssists = playerResults.map(p => {
		// Count total assists from other players' goals
		let primaryAssists = 0;
		let secondaryAssists = 0;
		playerResults.forEach(other => {
			other.goals.forEach(g => {
				if (g.assists[0] === p.name) primaryAssists++;
				if (g.assists[1] === p.name) secondaryAssists++;
			});
		});
		return {
			name: p.name,
			primaryAssists,
			secondaryAssists
		};
	});
	// Get newly injured players
	const newlyInjured = playerResults.filter(p => p.injuredThisGame);

	// Update player stats for this season in skaters_new
	playerResults.forEach(p => {
		if (p.injuryStatus === 'injured') return; // Skip injured players
		const existing = skaters_new.find(s => s.name === p.name && s.team === p.team);
		// Merge assist stats
		const playerAssistStats = playerAssists.find(a => a.name === p.name);
		p.I_F_primaryAssists = playerAssistStats ? playerAssistStats.primaryAssists : 0;
		p.I_F_secondaryAssists = playerAssistStats ? playerAssistStats.secondaryAssists : 0;
		// Update or add player stats
		if (existing) {
			existing.I_F_shotsOnGoal = (Number(existing.I_F_shotsOnGoal || 0) + p.shots).toString();
			existing.I_F_goals = (Number(existing.I_F_goals || 0) + p.goals.length).toString();
			existing.I_F_primaryAssists = (Number(existing.I_F_primaryAssists || 0) + p.I_F_primaryAssists).toString();
			existing.I_F_secondaryAssists = (Number(existing.I_F_secondaryAssists || 0) + p.I_F_secondaryAssists).toString();
			existing.games_played = (Number(existing.games_played || 0) + 1).toString();
			existing.I_F_hits = (Number(existing.I_F_hits || 0) + p.hits).toString();
			existing.shotsBlockedByPlayer = (Number(existing.shotsBlockedByPlayer || 0) + p.blocks).toString();
		} else {
			skaters_new.push({
				name: p.name,
				team: p.team,
				position: p.position,
				I_F_shotsOnGoal: p.shots.toString(),
				I_F_goals: p.goals.length.toString(),
				I_F_primaryAssists: p.I_F_primaryAssists.toString(),
				I_F_secondaryAssists: p.I_F_secondaryAssists.toString(),
				I_F_hits: p.hits.toString(),
				shotsBlockedByPlayer: '0',
			});
		}
	});

	// const randomFactor = 1 + (Math.random() * 0.2 - 0.1); // +/-10%
	return {
		shots: Math.round(totalShots),
		goals: Math.round(estimatedGoals),
		scorers: playerResults.filter(p => p.goals.length > 0),
		assists: playerResults.filter(p => p.assists > 0),
		hits: playerResults.reduce((sum, p) => sum + p.hits, 0),
		newlyInjured
	};
}

// Simulate a single game
function simulateGame (game) {
	const home = game?.away ? game.opponent : game.team;
	const away = game?.away ? game.team : game.opponent;

	// Get skaters for both teams, merging new data if available, and keep injury status
	function mergedSkaters (homeOrAway) {
		return (skatersByTeam[homeOrAway] || []).map(s => {
			const updated = skaters_new.find(n => n.name === s.name && n.team === s.team);
			if (updated) {
				return {
					...s,
					I_F_shotsOnGoal: (Number(s.I_F_shotsOnGoal || 0) + Number(updated.I_F_shotsOnGoal || 0)).toString(),
					I_F_goals: (Number(s.I_F_goals || 0) + Number(updated.I_F_goals || 0)).toString(),
					games_played: (Number(s.games_played || 0) + Number(updated.games_played || 0)).toString(),
					injuryStatus: updated.injuryStatus || s.injuryStatus,
					injuryGamesLeft: updated.injuryGamesLeft || s.injuryGamesLeft,
					injuryRisk: s.injuryRisk,
					I_F_primaryAssists: (Number(s.I_F_primaryAssists || 0) + Number(updated.I_F_primaryAssists || 0)).toString(),
					I_F_secondaryAssists: (Number(s.I_F_secondaryAssists || 0) + Number(updated.I_F_secondaryAssists || 0)).toString(),
					I_F_hits: (Number(s.I_F_hits || 0) + Number(updated.I_F_hits || 0)).toString()
				};
			} else {
				return s;
			}
		})
	}

	const homeSkaters = mergedSkaters(home);
	const awaySkaters = mergedSkaters(away);

	// Get goalies for both teams, merging new data if available, and keep injury status
	function mergedGoalies (homeOrAway) {
		return (goaliesByTeam[homeOrAway] || []).map(s => {
			const updated = goalies_new.find(n => n.name === s.name && n.team === s.team);
			if (updated) {
				return {
					...s,
					games_played: (Number(s.games_played || 0) + Number(updated.games_played || 0)).toString(),
					goals: (Number(s.goals || 0) + Number(updated.goals || 0)).toString(),
					unblocked_shot_attempts: (Number(s.unblocked_shot_attempts || 0) + Number(updated.unblocked_shot_attempts || 0)).toString(),
					shutouts: (Number(s.shutouts || 0) + Number(updated.shutouts || 0)).toString(),
					wins: (Number(s.wins || 0) + Number(updated.wins || 0)).toString(),
					injuryStatus: updated.injuryStatus || s.injuryStatus,
					injuryGamesLeft: updated.injuryGamesLeft || s.injuryGamesLeft,
					injuryRisk: s.injuryRisk
				};
			} else {
				return s;
			}
		})
	}

	const homeGoalies = mergedGoalies(home);
	const awayGoalies = mergedGoalies(away);

	// Pick a starting goalie for each team.
	function pickStartingGoalie (goalies) {
		if (goalies.length === 0) return null;
		// Get games played percentage for each goalie, out of 82
		for (const g of goalies) {
			g.games_pct = Math.min(1, (Number(g.games_played || 0) / 82));
		}
		// Weighted random pick based on games played percentage
		const totalWeight = goalies.reduce((sum, g) => sum + g.games_pct, 0);
		let rand = Math.random() * totalWeight;
		for (const g of goalies) {
			rand -= g.games_pct;
			if (rand <= 0) return g;
		}
		return null;
	}

	const homeStartingGoalie = pickStartingGoalie(homeGoalies);
	const awayStartingGoalie = pickStartingGoalie(awayGoalies);

	// Estimate game results
	const homeStats = goalEstimator(homeSkaters, awayStartingGoalie);
	const awayStats = goalEstimator(awaySkaters, homeStartingGoalie);

	let homeScore = homeStats.goals;
	let awayScore = awayStats.goals;
	let overtime = false;

	// Prevent ties: if tied, give win to team with highest avg goals in skaters_new
	if (homeScore === awayScore) {
		overtime = true;
		// Calculate average goals for each team in skaters_new
		function avgGoals (teamName) {
			const players = skaters_new.filter(s => s.team === teamName);
			const totalGoals = players.reduce((sum, s) => sum + Number(s.I_F_goals || 0), 0);
			const totalGames = players.reduce((sum, s) => sum + Number(s.games_played || 0), 0);
			return totalGames > 0 ? totalGoals / totalGames : 0;
		}
		const homeAvg = avgGoals(home);
		const awayAvg = avgGoals(away);
		if (homeAvg > awayAvg) {
			homeScore++;
		} else if (awayAvg > homeAvg) {
			awayScore++;
		} else {
			// If still tied, pick randomly
			if (Math.random() < 0.5) {
				homeScore++;
			} else {
				awayScore++;
			}
		}
	}

	// Update goalie stats for this season in goalies_new
	function updateGoalieStats (goalie, goalsAgainst, shotsAgainst, win = false) {
		if (!goalie) return;
		const existing = goalies_new.find(g => g.name === goalie.name && g.team === goalie.team);
		if (existing) {
			existing.goals = (Number(existing.goals || 0) + goalsAgainst).toString();
			existing.unblocked_shot_attempts = (Number(existing.unblocked_shot_attempts || 0) + shotsAgainst).toString();
			existing.games_played = (Number(existing.games_played || 0) + 1).toString();
			// Shut outs
			if (goalsAgainst === 0) {
				existing.shutouts = (Number(existing.shutouts || 0) + 1).toString();
			}
			if (win) {
				existing.wins = (Number(existing.wins || 0) + 1).toString();
			}
		} else {
			goalies_new.push({
				name: goalie.name,
				team: goalie.team,
				goals: goalsAgainst.toString(),
				unblocked_shot_attempts: shotsAgainst.toString(),
				games_played: '1',
				shutouts: goalsAgainst === 0 ? '1' : '0',
				wins: '0',
			});
		}
	}

	updateGoalieStats(homeStartingGoalie, awayScore, awayStats.shots, homeScore > awayScore);
	updateGoalieStats(awayStartingGoalie, homeScore, homeStats.shots, awayScore > homeScore);

	return {
		gameId: game.gameId || game.GameId || game.id,
		date: game.date || game.Date || game.gameDate,
		home: {
			name: home,
			shots: homeStats.shots,
			goals: homeScore,
			scorers: homeStats.scorers,
			assists: homeStats.assists,
			goalie: homeStartingGoalie ? homeStartingGoalie.name : null,
			injured: homeStats.newlyInjured
		},
		away: {
			name: away,
			shots: awayStats.shots,
			goals: awayScore,
			scorers: awayStats.scorers,
			assists: awayStats.assists,
			goalie: awayStartingGoalie ? awayStartingGoalie.name : null,
			injured: awayStats.newlyInjured
		},
		homeScore,
		awayScore,
		overtime
	};
}

// Simulate all games
const results = sortedSchedule.filter(game => game.gameId).map(simulateGame);
// const results = [simulateGame(sortedSchedule[0])];


// Export results to /results/season.json grouped by date
const resultsByDate = {};
results.forEach(r => {
	const date = r.date;
	if (!resultsByDate[date]) resultsByDate[date] = { games: [] };
	resultsByDate[date].games.push({
		gameId: r.gameId,
		home: r.home,
		away: r.away,
		homeScore: r.homeScore,
		awayScore: r.awayScore
	});
});

fs.writeFileSync(
	path.join(__dirname, 'results', 'season.json'),
	JSON.stringify(resultsByDate, null, 2),
	'utf8'
);
console.log('Season results exported to /results/season.json');

// Calculate points earned by each player
// Goals = 3 points
// Assists = 2 points
// Shots = 0.25 points
// Hits = 0.5 points
// Blocks = 0.5 points
// console.log('\nSeason Skater Stats:');
// skaters_new = skaters_new.map(s => {
// 	const goals = Number(s.I_F_goals || 0);
// 	const shots = Number(s.I_F_shotsOnGoal || 0);
// 	const assists = Number(s.I_F_assists || 0);
// 	const hits = Number(s.I_F_hits || 0);
// 	const shotsBlocked = Number(s.shotsBlockedByPlayer || 0);
// 	const points = (goals * 3) + (assists * 2) + (shots * 0.25) + (hits * 0.5) + (shotsBlocked * 0.5);
// 	return {
// 		...s,
// 		points
// 	};
// }).sort((a, b) => b.points - a.points);

fs.writeFileSync(
	path.join(__dirname, 'results', 'skaters.json'),
	JSON.stringify(skaters_new, null, 2),
	'utf8'
);

// Print top 10 players by points in each position
['C', 'L', 'R', 'D'].forEach(position => {
	console.log(`\nTop 10 ${position}s by Points:`);
	skaters_new.filter(s => s.position === position).slice(0, 10).forEach(s => {
		console.log(`  ${s.name}: ${s.points} points`);
	});
});

// Calculate points earned by each goalie
// Wins = 2.5 points
// Shutouts = 2.5 points
// Saves = 0.3 points
// Goals against = -1 point
// console.log('\nSeason Goalie Stats:');
// goalies_new = goalies_new.map(g => {
// 	const wins = Number(g.wins || 0);
// 	const shutouts = Number(g.shutouts || 0);
// 	const saves = Number(g.unblocked_shot_attempts - g.goals || 0);
// 	const goalsAgainst = Number(g.goals || 0);
// 	const points = Math.round((wins * 2.5) + (shutouts * 2.5) + (saves * 0.3) + (goalsAgainst * -1));
// 	return {
// 		...g,
// 		points
// 	};
// }).sort((a, b) => b.points - a.points);

fs.writeFileSync(
	path.join(__dirname, 'results', 'goalies.json'),
	JSON.stringify(goalies_new, null, 2),
	'utf8'
);

// Print top 10 goalies by points
console.log(`\nTop 10 Goalies by Points:`);
goalies_new.slice(0, 10).forEach(g => {
	console.log(`  ${g.name}: ${g.points} points (${g.games_played} games, ${g.wins} wins, ${g.shutouts} shutouts, ${g.goals} GA, ${g.unblocked_shot_attempts - g.goals} saves)`);
});

// Print the conference standings
const standings = results.reduce((acc, game) => {
	if (!acc[game.home.name]) acc[game.home.name] = { team: game.home.name, wins: 0, losses: 0, otl: 0, otw: 0, points: 0, goalsFor: 0, goalsAgainst: 0 };
	if (!acc[game.away.name]) acc[game.away.name] = { team: game.away.name, wins: 0, losses: 0, otl: 0, otw: 0, points: 0, goalsFor: 0, goalsAgainst: 0 };
	acc[game.home.name].goalsFor += game.homeScore;
	acc[game.home.name].goalsAgainst += game.awayScore;
	acc[game.away.name].goalsFor += game.awayScore;
	acc[game.away.name].goalsAgainst += game.homeScore;
	// No ties allowed: only wins and losses
	if (game.homeScore > game.awayScore) {
		if (game.overtime) {
			acc[game.home.name].otw += 1;
			acc[game.home.name].points += 2;
			acc[game.away.name].otl += 1;
			acc[game.away.name].points += 1;
		} else {
			acc[game.home.name].wins += 1;
			acc[game.home.name].points += 3;
			acc[game.away.name].losses += 1;
			acc[game.away.name].points += 0;
		}
	} else {
		if (game.overtime) {
			acc[game.away.name].otw += 1;
			acc[game.away.name].points += 2;
			acc[game.home.name].otl += 1;
			acc[game.home.name].points += 1;
		} else {
			acc[game.away.name].wins += 1;
			acc[game.away.name].points += 3;
			acc[game.home.name].losses += 1;
			acc[game.home.name].points += 0;
		}
	}
	return acc;
}, {});

// Print the standings
console.log('\n Season League Standings:');
Object.values(standings).sort((a, b) => b.points - a.points).forEach(team => {
	console.log(`  ${team.team}: ${team.wins + team.otw} - ${team.losses} - ${team.otl} | ${team.points} points | GF: ${team.goalsFor} | GA: ${team.goalsAgainst}`);
});