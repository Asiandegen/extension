/**
 * Background Script (Service Worker) for Dice Bot Extension (v0.2.0 - Custom Scripting)
 * - Handles core betting logic and API calls.
 * - Manages bot state (running, profit, balance, etc.).
 * - Communicates with content script(s) to update UI and receive commands.
 * - Uses chrome.storage for persistence.
 * - Includes EXPERIMENTAL custom script execution.
 */

// --- Global State (Service Worker context) ---
let isRunning = false;
let currentBalance = 0;
let currentCurrency = 'btc';
let profitTotal = 0;
let wageredTotal = 0;
let wins = 0;
let losses = 0;
let currentStreak = 0;
let currentBetCount = 0;
let startTime = null;
let timerInterval = null;
let botSettings = {}; // Loaded from storage
let activeTabId = null; // Track the tab where the bot is active
let ws = null; // WebSocket connection (placeholder)
let apiToken = null; // User's session token
let betDelay = 150; // ms delay between bets
let lastBetStatsForScript = null; // Store details of the last bet for the custom script

// Default custom script content (used if nothing is loaded)
const DEFAULT_CUSTOM_SCRIPT = `// Define your custom strategy logic here
// The function must be named nextBet and accept 'stats' object
// It must return an object: { betAmount: number, betHigh: boolean, chance: number }

function nextBet(stats) {
    console.log("Custom script received stats:", stats);

    // Example: Simple Martingale (double bet on loss, reset on win)
    let nextBetAmount = stats.baseBet; // Default to base bet

    if (stats.lastBet && !stats.lastBet.win) { // Check if lastBet exists and was a loss
        nextBetAmount = stats.lastBet.amount * 2;
    }

    // Ensure bet doesn't exceed balance (important!)
    // Use a small tolerance (e.g., 0.00000001) for floating point comparisons
    if (nextBetAmount > (stats.current_balance + 0.00000001)) {
        console.warn("Custom script bet exceeds balance, resetting to base bet.");
        nextBetAmount = stats.baseBet;
        if (nextBetAmount > (stats.current_balance + 0.00000001)) {
             console.error("Base bet also exceeds balance!");
             // Consider stopping the bot here or setting a minimum possible bet
             nextBetAmount = 0.00000001; // Fallback minimum
             // Or signal error: throw new Error("Base bet exceeds balance, cannot continue.");
        }
    }
     // Ensure bet is not zero or negative
     if (nextBetAmount <= 0) {
        console.warn("Custom script calculated non-positive bet, using minimum.");
        nextBetAmount = 0.00000001; // Fallback minimum
     }


    // Return the calculated bet amount, keep original chance and betHigh setting from UI
    // Or allow script to override them by reading stats.chance / stats.betHigh
    return {
        betAmount: nextBetAmount,
        betHigh: stats.betHigh,     // Use the UI setting for betHigh by default
        chance: stats.chance        // Use the UI setting for chance by default
    };
}`;


// --- Storage Keys ---
const STORAGE_KEYS = {
    SETTINGS: 'diceBot_settings_v3_custom' // Updated key for this version
};

// --- Initialization ---
chrome.runtime.onInstalled.addListener(() => {
    console.log("Dice Bot Extension Installed/Updated (v0.2.0).");
    loadSettingsFromStorage(); // Load settings when installed/updated
});

chrome.runtime.onStartup.addListener(() => {
     console.log("Dice Bot Extension Started.");
     loadSettingsFromStorage(); // Load settings on browser start
});

// Keep service worker alive while bot is running (basic method)
let keepAliveInterval;
function startKeepAlive() {
    stopKeepAlive(); // Clear previous interval if any
    console.log("Starting keep-alive ping.");
    keepAliveInterval = setInterval(() => {
        // console.log("Service worker keep-alive ping");
        if (chrome.runtime?.id && activeTabId) { // Check if extension context is still valid
             chrome.tabs.sendMessage(activeTabId, { action: "ping" }).catch(e => {
                 // Ignore errors like "Could not establish connection" if tab closed
                 if (!e.message.includes("Could not establish connection") && !e.message.includes("Receiving end does not exist")) {
                     console.warn("Keep-alive ping failed:", e.message);
                 }
             });
        } else {
             console.log("Keep-alive: Extension context or active tab lost.");
             // If the bot was running, maybe stop it?
             if (isRunning) {
                 stopBot("Keep-alive context lost");
             } else {
                 stopKeepAlive(); // Stop pinging if bot isn't running anyway
             }
        }
    }, 20 * 1000); // Ping every 20 seconds
}
function stopKeepAlive() {
    if (keepAliveInterval) {
        console.log("Stopping keep-alive ping.");
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}


// --- Message Handling ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("BG Received:", message); // Optional: Log received messages

    // Store the tab ID from which the message came, especially for UI updates
    if (sender.tab && sender.tab.id) {
        activeTabId = sender.tab.id;
    }

    let needsAsyncResponse = false; // Flag if we need to return true from the listener

    switch (message.action) {
        case "start_bot":
            needsAsyncResponse = true; // startBot is async
            startBot(message.data).then(() => {
                sendResponse({ status: "started_or_failed" }); // Respond after start attempt
            }).catch(error => {
                console.error("Start bot error:", error);
                sendResponse({ status: "error", message: error.message });
            });
            break;
        case "stop_bot":
            stopBot();
            sendResponse({ status: "stopped" });
            break;
        case "reset_stats":
            resetStats();
            sendStateToContentScript();
            sendResponse({ status: "stats_reset" });
            break;
        case "check_balance":
             needsAsyncResponse = true;
             fetchUserBalances().then(() => sendResponse({ status: "balance_checked" }));
            break;
        case "reset_seed":
             needsAsyncResponse = true;
             resetSeed().then(() => sendResponse({ status: "seed_reset" }));
            break;
        case "save_setting":
             needsAsyncResponse = true; // Saving is async
             saveSetting(message.data.key, message.data.value)
                 .then(() => sendResponse({ status: "setting_saved" }))
                 .catch(e => sendResponse({ status: "error", message: "Failed to save setting"}));
            break;
        case "get_initial_state":
             needsAsyncResponse = true;
             // Ensure settings are loaded before sending
             loadSettingsFromStorage().then(async () => { // Make sure load is complete
                 sendStateToContentScript(); // Send current running state etc.
                 sendSettingsToContentScript(); // Send loaded settings to UI
                 if (!apiToken) await getTokenFromCookie(); // Attempt to get token if missing
                 if (currentBalance === 0) await fetchUserBalances(); // Attempt to get balance if missing
                 sendResponse({ status: "initial_state_sent"});
             });
            break;
        case "pong": // Response from content script keep-alive
            // console.log("BG received pong from CS");
            break;
    }

    return needsAsyncResponse; // Return true ONLY if we performed async operations before sendResponse could be called
});


// --- Core Bot Logic Functions ---

async function startBot(uiSettings) {
    if (isRunning) {
        logAndSend("Bot is already running.");
        return;
    }

    logAndSend("--- Starting Bot ---");
    let startError = null;
    let initialBet = 0; // Define outside try block

    try {
        // 1. Load/Validate Settings
        // Ensure botSettings is up-to-date before merging UI settings
        await loadSettingsFromStorage();
        botSettings = { ...botSettings, ...uiSettings }; // Merge UI settings into current settings
        currentCurrency = botSettings.currency || 'btc';

        // Validate common settings
        if (isNaN(parseFloat(botSettings.baseBet)) || parseFloat(botSettings.baseBet) <= 0) throw new Error("Invalid Base Bet.");
        if (isNaN(parseFloat(botSettings.chance)) || parseFloat(botSettings.chance) < 0.01 || parseFloat(botSettings.chance) > 99.99) throw new Error("Invalid Chance.");
        if (!botSettings.currency) throw new Error("No currency selected.");
        botSettings.stopProfit = parseFloat(botSettings.stopProfit) || 0;
        botSettings.stopLoss = parseFloat(botSettings.stopLoss) || 0;
        botSettings.numBets = parseInt(botSettings.numBets) || 0;
        if (botSettings.stopProfit < 0 || botSettings.stopLoss < 0 || botSettings.numBets < 0) throw new Error("Stop limits cannot be negative.");


        // Validate custom script if enabled
        if (botSettings.useCustomScript) {
             logAndSend("Validating custom script syntax...");
             if (!botSettings.customScriptCode || botSettings.customScriptCode.trim() === '') throw new Error("Custom script code is empty.");
             // Basic syntax check - will throw error if invalid
             new Function('stats', `${botSettings.customScriptCode}\n if (typeof nextBet !== 'function') throw new Error();`);
             logAndSend("Custom script syntax OK (basic check).");
        }

        // 2. Get API Token
        await getTokenFromCookie();
        if (!apiToken) throw new Error("Authentication token not found. Please ensure you are logged in and grant 'cookies' permission if needed.");

        // 3. Fetch Initial Balance
        const balanceOK = await fetchUserBalances();
        if (!balanceOK || currentBalance <= 0) throw new Error("Could not get valid starting balance.");

        // Store starting balance for percentage calculations
        botSettings.started_bal = currentBalance;
        // Don't await save here, not critical for starting
        saveSetting('started_bal', currentBalance);

        // 4. Determine Initial Bet Amount
        initialBet = parseFloat(botSettings.baseBet); // Start with baseBet
        if (botSettings.useCustomScript) {
            logAndSend("Running custom script for initial bet...");
            const stats = { // Prepare stats object for initial run
                current_balance: currentBalance, profit_total: 0, wagered: 0, wins: 0, losses: 0,
                currentstreak: 0, currentBetCount: 0, startTime: null, lastBet: null,
                baseBet: initialBet, // Pass the base bet from UI
                chance: parseFloat(botSettings.chance), betHigh: botSettings.betHigh
            };
            const result = executeCustomScript(botSettings.customScriptCode, stats); // Will throw on error
            initialBet = result.betAmount;
            // Update settings based on initial script run if needed (allow script to set initial chance/high)
            botSettings.betHigh = result.betHigh;
            botSettings.chance = result.chance;
            logAndSend(`Custom script initial bet: ${initialBet.toFixed(8)}, High: ${botSettings.betHigh}, Chance: ${botSettings.chance}%`);
        }

        if (initialBet > currentBalance) throw new Error(`Initial bet (${initialBet.toFixed(8)}) > balance (${currentBalance.toFixed(8)}).`);

        // 5. Reset Stats & Start State
        resetStats(true); // Reset stats, keep balance
        isRunning = true;
        startTime = new Date();
        startTimer();
        startKeepAlive(); // Keep service worker active
        sendStateToContentScript(); // Update UI

        logAndSend(`Starting Balance: ${currentBalance.toFixed(8)} ${currentCurrency.toUpperCase()}`);
        logAndSend(`Strategy: ${botSettings.useCustomScript ? 'CUSTOM SCRIPT' : 'Flat Betting'}`);
        if (!botSettings.useCustomScript) {
             logAndSend(`Flat Bet Settings: Bet=${initialBet.toFixed(8)}, Chance=${botSettings.chance}%, High=${botSettings.betHigh}`);
        }

        // 6. Initiate Betting Loop
        initiateNextBet(); // Start with the calculated initial bet

    } catch (error) {
        startError = error; // Store error to handle after catch block
    }

    // Handle start errors outside the catch block
    if (startError) {
         logAndSend(`Start failed: ${startError.message}`);
         sendAlertToContentScript(`Start failed: ${startError.message}`);
         isRunning = false; // Ensure bot is not marked as running
         stopKeepAlive(); // Stop keep-alive if start failed
         sendStateToContentScript(); // Update UI to show stopped state
    }
}


function stopBot(reason = "User action") {
    if (!isRunning) return;
    logAndSend(`--- Stopping Bot (${reason}) ---`);
    isRunning = false;
    stopTimer();
    stopKeepAlive(); // Stop keep-alive interval
    // closeWebSocket(); // Close WS if open
    sendStateToContentScript();
    logAndSend(`Final Stats: Profit=${profitTotal.toFixed(8)}, Wagered=${wageredTotal.toFixed(8)}, Bets=${currentBetCount} (W/L: ${wins}/${losses})`);
}

function initiateNextBet() {
    if (!isRunning) return;

    let betAmount, chance, betHigh;

    try {
        if (botSettings.useCustomScript) {
            // Execute custom script to get next bet parameters
            const stats = {
                current_balance: currentBalance, profit_total: profitTotal, wagered: wageredTotal,
                wins: wins, losses: losses, currentstreak: currentStreak, currentBetCount: currentBetCount,
                startTime: startTime, lastBet: lastBetStatsForScript, // Pass last bet details
                baseBet: parseFloat(botSettings.baseBet), // Pass current base bet setting
                // Pass current chance/high settings, script can use or override them
                chance: parseFloat(botSettings.chance),
                betHigh: botSettings.betHigh
            };
            const result = executeCustomScript(botSettings.customScriptCode, stats); // Throws on error
            betAmount = result.betAmount;
            chance = result.chance; // Use chance from script result
            betHigh = result.betHigh; // Use betHigh from script result
            // logAndSend(`Custom script: Bet=${betAmount.toFixed(8)}, High=${betHigh}, Chance=${chance}%`); // Logged inside executeCustomScript now
        } else {
            // Flat Betting Logic
            betAmount = parseFloat(botSettings.baseBet);
            chance = parseFloat(botSettings.chance);
            betHigh = botSettings.betHigh;
        }

        // Validate calculated values
        if (isNaN(betAmount) || betAmount <= 0) throw new Error(`Invalid bet amount: ${betAmount}`);
        if (isNaN(chance) || chance < 0.01 || chance > 99.99) throw new Error(`Invalid chance: ${chance}`);
        if (betAmount > (currentBalance + 0.000000001)) throw new Error(`Insufficient funds for bet (${betAmount.toFixed(8)} > ${currentBalance.toFixed(8)})`);

        // Place the bet (async operation)
        placeBet(betAmount, chance, betHigh);

    } catch (error) {
        logAndSend(`Error preparing next bet: ${error.message}`);
        stopBot(`Error preparing bet: ${error.message}`);
        sendAlertToContentScript(`Stopping: Error preparing bet - ${error.message}`);
    }
}

// Function to execute custom script safely (using new Function)
function executeCustomScript(code, stats) {
    // ** SECURITY WARNING: Executing untrusted code is dangerous! **
    console.warn("Executing custom script code. Ensure it is trusted!");
    logAndSend("Executing custom script..."); // Log execution attempt

    try {
        // Create the function constructor dynamically
        const userFunction = new Function('stats', `
            ${code}
            // Ensure the nextBet function exists within the provided code
            if (typeof nextBet !== 'function') {
                throw new Error('Custom script must define a function named nextBet(stats)');
            }
            // Execute the user-defined nextBet function
            return nextBet(stats);
        `);

        // Execute the function with the provided stats
        const result = userFunction(stats);

        // Validate the structure and types of the returned result
        if (typeof result !== 'object' || result === null ||
            typeof result.betAmount !== 'number' || isNaN(result.betAmount) || result.betAmount <= 0 ||
            typeof result.betHigh !== 'boolean' ||
            typeof result.chance !== 'number' || isNaN(result.chance) || result.chance < 0.01 || result.chance > 99.99)
        {
            // Throw a detailed error if validation fails
            throw new Error("Custom script 'nextBet' function must return an object { betAmount: number > 0, betHigh: boolean, chance: number (0.01-99.99) }");
        }

        logAndSend(`Custom script returned: Bet=${result.betAmount.toFixed(8)}, High=${result.betHigh}, Chance=${result.chance}%`);
        return result; // Return validated result

    } catch (error) {
        console.error("Custom Script Execution Error:", error);
        // Re-throw the error to be caught by the caller (initiateNextBet or startBot)
        // Include specific error details if possible
        throw new Error(`Custom Script Error: ${error.message}`);
    }
}


async function placeBet(amount, chance, betHigh) {
    if (!isRunning) return;
    if (!apiToken) { stopBot("API Token missing"); return; }

    let target, cond, apiQuery, opName, mutName, vars, body;
    const host = await getCurrentHost();
    const endpoint = `https://${host}/_api/graphql`;

    if (!host) { logAndSend("Error: Could not determine target host."); stopBot("Host determination failed"); return; }

    // Construct API call (same logic as before)
    if (host.includes("primedice")) {
        target = betHigh ? (100 - 0.01 - chance) : chance; cond = betHigh ? "above" : "below"; opName = "PrimediceRoll"; mutName = "primediceRoll";
        vars = { amount, target, condition: cond, currency: currentCurrency };
        apiQuery = `mutation ${opName}($amount: Float!, $target: Float!, $condition: CasinoGamePrimediceConditionEnum!, $currency: CurrencyEnum!) { ${mutName}(amount: $amount, target: $target, condition: $condition, currency: $currency) { ...CasinoBetFragment state { ...PrimediceStateFragment __typename } __typename } } fragment CasinoBetFragment on CasinoBet { id active payoutMultiplier amountMultiplier amount payout updatedAt currency game user { id name __typename } __typename } fragment PrimediceStateFragment on CasinoGamePrimedice { result target condition __typename }`;
    } else { // Assume Stake
        target = betHigh ? (100 - chance) : chance; cond = betHigh ? "above" : "below"; opName = "DiceRoll"; mutName = "diceRoll";
        vars = { amount, target, condition: cond, currency: currentCurrency, identifier: randomString(21) };
        apiQuery = `mutation ${opName}($amount: Float!, $target: Float!, $condition: CasinoGameDiceConditionEnum!, $currency: CurrencyEnum!, $identifier: String!) { ${mutName}(amount: $amount, target: $target, condition: $condition, currency: $currency, identifier: $identifier) { ...CasinoBet state { ...CasinoGameDice } } } fragment CasinoBet on CasinoBet { id active payoutMultiplier amountMultiplier amount payout updatedAt currency game user { id name } } fragment CasinoGameDice on CasinoGameDice { result target condition }`;
    }
    body = { operationName: opName, variables: vars, query: apiQuery };

    try {
        const response = await fetch(endpoint, { method: 'post', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'x-access-token': apiToken } });
        if (!response.ok) throw new Error(`API HTTP Error: ${response.status} ${response.statusText}`);
        const json = await response.json();
        // Pass bet details used for this specific API call to handler
        handleApiResponse(json, mutName, { amount, chance, betHigh });
    } catch (error) {
        logAndSend(`Bet Placement Network/Fetch Error: ${error.message}`);
        if (isRunning) { logAndSend("Retrying bet after delay..."); setTimeout(initiateNextBet, 3000); }
    }
}

// Modified to receive the actual bet parameters used for the API call
function handleApiResponse(json, mutationName, betParams) {
    if (!isRunning) return;

    // --- Validation (same as before) ---
    if (!json || json.errors || !json.data || !json.data[mutationName]) { /* ... error handling ... */ return; }
    const d = json.data[mutationName]; const s = d.state;
    if (!s) { /* ... error handling ... */ return; }
    const betAmount = parseFloat(d.amount), payout = parseFloat(d.payout), roll = parseFloat(s.result);
    const target = parseFloat(s.target), cond = s.condition, betId = d.id, gameName = d.game || "dice";
    if (isNaN(betAmount) || isNaN(payout) || isNaN(roll) || !s || !cond) { /* ... error handling ... */ return; }

    // --- Update State ---
    const win = payout > 0;
    const profitNow = payout - betAmount;
    profitTotal += profitNow;
    wageredTotal += betAmount;
    losses += win ? 0 : 1;
    wins += win ? 1 : 0;
    currentBetCount++;
    if (win) { currentStreak = (currentStreak > 0) ? currentStreak + 1 : 1; }
    else { currentStreak = (currentStreak < 0) ? currentStreak - 1 : -1; }
    currentBalance += profitNow; // Update balance immediately

    // Store last bet details for custom script's *next* execution
     lastBetStatsForScript = {
         amount: betAmount, win: win, profit: profitNow, roll: roll,
         target: target, condition: cond,
         // Use the actual chance/betHigh sent in the API call for consistency
         chance: betParams.chance,
         betHigh: betParams.betHigh
     };

    // --- Update UI ---
    sendStateToContentScript();
    sendMessageToContentScript({ action: "set_result", data: { roll: roll, win: win } });
    sendMessageToContentScript({ action: "add_history", data: {
        betNumber: wins + losses, gameName: gameName, amount: betAmount,
        cond: cond, target: target, roll: roll, profit: profitNow, win: win, betId: betId
    }});

    // --- Check Stop Conditions ---
    if (botSettings.stopProfit > 0 && profitTotal >= botSettings.stopProfit) { stopBot(`Stop Profit @ ${profitTotal.toFixed(8)}`); return; }
    if (botSettings.stopLoss > 0 && profitTotal <= -botSettings.stopLoss) { stopBot(`Stop Loss @ ${profitTotal.toFixed(8)}`); return; }
    if (botSettings.numBets > 0 && currentBetCount >= botSettings.numBets) { stopBot(`Bet Limit Reached @ ${currentBetCount}`); return; }

    // --- Schedule Next Bet ---
    if (isRunning) {
        setTimeout(initiateNextBet, betDelay);
    }
}


function resetStats(keepBalance = false) {
    logAndSend("Resetting stats...");
    if (!keepBalance) {
        botSettings.started_bal = currentBalance;
        saveSetting('started_bal', currentBalance);
    }
    profitTotal = 0; wageredTotal = 0; wins = 0; losses = 0;
    currentStreak = 0; currentBetCount = 0; lastBetStatsForScript = null;
    // stopTimer(); // Keep timer running unless explicitly stopping bot?

    sendStateToContentScript(); // Send cleared stats
}

async function resetSeed() {
    logAndSend("Attempting seed reset...");
    if (!apiToken) { logAndSend("Cannot reset seed: Token missing."); return; }
    const host = await getCurrentHost();
     if (!host) { logAndSend("Cannot reset seed: Host unknown."); return; }
    const endpoint = `https://${host}/_api/graphql`;
    const cs = randomString(10);
    const body = { opName: "RotateSeedPair", vars: { seed: cs }, query: `mutation RotateSeedPair($seed: String!) { rotateSeedPair(seed: $seed) { clientSeed { user { id activeClientSeed { id seed __typename } activeServerSeed { id nonce seedHash nextSeedHash __typename } __typename } __typename } __typename } }` };

    try {
        const response = await fetch(endpoint, { method: 'post', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'x-access-token': apiToken } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        if (json.errors) { logAndSend("Seed API Err: " + (json.errors[0]?.message || "Unknown")); }
        else if (json.data?.rotateSeedPair) { logAndSend(`Seed successfully reset.`); sendAlertToContentScript("Seed rotated successfully."); }
        else { logAndSend("Seed reset ok, unexpected response."); }
    } catch (err) { logAndSend("Seed reset net err: " + err); }
}


// --- Storage Functions ---
async function saveSetting(key, value) {
    const settingKeyMap = { // Map UI IDs to storage keys
        baseBetInput: 'baseBet', chanceInput: 'chance', betHighInput: 'betHigh',
        stopOnProfitInput: 'stopProfit', stopOnLossInput: 'stopLoss', numberOfBetsInput: 'numBets',
        currency: 'currency', theme: 'theme', useCustomScriptInput: 'useCustomScript',
        customScriptCode: 'customScriptCode', started_bal: 'started_bal'
    };
    const actualKey = settingKeyMap[key] || key;
    if (!actualKey) { console.warn("Attempted to save unknown setting key:", key); return; }

    let processedValue = value;
    // Coerce types based on key
     if (['baseBet', 'chance', 'stopProfit', 'stopLoss', 'started_bal'].includes(actualKey)) processedValue = parseFloat(value);
     else if (['numBets'].includes(actualKey)) processedValue = parseInt(value);
     else if (['betHigh', 'useCustomScript'].includes(actualKey)) processedValue = !!value;

    // Update local copy
    botSettings[actualKey] = processedValue;
    if (actualKey === 'currency') currentCurrency = processedValue;

    try {
        // Use structuredClone for deep copy if settings become complex objects
        await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: botSettings });
        console.log("Saved setting:", actualKey, processedValue);
    } catch (error) {
        console.error("Error saving settings:", error);
        logAndSend("Error saving setting to storage.");
    }
}

async function loadSettingsFromStorage() {
    try {
        const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
        const loadedSettings = result[STORAGE_KEYS.SETTINGS];
        const defaultSettings = { // Define defaults clearly
            baseBet: 0.00000001, chance: 49.5, betHigh: true,
            currency: 'btc', theme: 'light',
            stopProfit: 0, stopLoss: 0, numBets: 0,
            useCustomScript: false, customScriptCode: DEFAULT_CUSTOM_SCRIPT,
            started_bal: 0
        };
        if (loadedSettings) {
            botSettings = { ...defaultSettings, ...loadedSettings }; // Merge loaded with defaults
            currentCurrency = botSettings.currency || 'btc';
            console.log("Settings loaded/merged from storage:", botSettings);
        } else {
            console.log("No settings found in storage, using defaults.");
            botSettings = defaultSettings;
            currentCurrency = 'btc';
            await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: botSettings }); // Save defaults
        }
    } catch (error) {
        console.error("Error loading settings:", error);
        // Fallback to defaults on error
        botSettings = { baseBet: 0.00000001, chance: 49.5, betHigh: true, currency: 'btc', theme: 'light', stopProfit: 0, stopLoss: 0, numBets: 0, useCustomScript: false, customScriptCode: DEFAULT_CUSTOM_SCRIPT, started_bal: 0 };
        currentCurrency = 'btc';
    }
}

// --- Balance / Token / Host Helpers ---
async function fetchUserBalances() {
    if (!apiToken) await getTokenFromCookie();
    if (!apiToken) { logAndSend("Cannot fetch balance: Token missing."); return false; }
    const host = await getCurrentHost();
    if (!host) { logAndSend("Cannot fetch balance: Host unknown."); return false; }
    const endpoint = `https://${host}/_api/graphql`;
    const query = { opName: "UserBalances", vars: {}, query: `query UserBalances { user { id balances { available { amount currency __typename } } __typename } }` };
    try {
        const response = await fetch(endpoint, { method: 'post', body: JSON.stringify({ operationName: query.opName, variables: query.vars, query: query.query }), headers: { 'Content-Type': 'application/json', 'x-access-token': apiToken } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        if (json.errors) { logAndSend("Bal API err: " + (json.errors[0]?.message || "Unknown")); return false; }
        if (json.data?.user?.balances) {
            const coins = []; let foundCurrent = false;
            json.data.user.balances.forEach(b => { if (b.available) { coins.push({ currency: b.available.currency, amount: b.available.amount }); if (b.available.currency === currentCurrency) { currentBalance = parseFloat(b.available.amount); foundCurrent = true; } } });
            if (!foundCurrent && coins.length > 0) { currentCurrency = coins[0].currency; currentBalance = parseFloat(coins[0].amount); botSettings.currency = currentCurrency; await saveSetting('currency', currentCurrency); }
            else if (coins.length === 0) { currentBalance = 0; }
            logAndSend(`Balance Updated: ${currentBalance.toFixed(8)} ${currentCurrency.toUpperCase()}`);
            sendBalanceToContentScript();
            sendMessageToContentScript({ action: "update_coins", data: { coins: coins, selected: currentCurrency } });
            return true;
        } else { logAndSend("Bad balance response format."); return false; }
    } catch (err) { logAndSend("Balance fetch network err: " + err); return false; }
}

async function getTokenFromCookie() {
    const hostDomain = await getCurrentHostDomain();
    if (!hostDomain) { console.error("Cannot get token: Host domain unknown."); apiToken = null; return; }
    // Construct multiple potential URLs since cookie domain might be tricky
    const potentialUrls = [`https://${hostDomain}/`, `https://www.${hostDomain}/`];
    apiToken = null; // Reset token before trying
    for (const url of potentialUrls) {
        try {
            const cookie = await chrome.cookies.get({ url: url, name: 'session' });
            if (cookie && cookie.value) {
                apiToken = cookie.value;
                console.log(`API Token retrieved via chrome.cookies for URL: ${url}`);
                break; // Stop searching once found
            } else {
                console.log(`API Token cookie 'session' not found for url: ${url}`);
            }
        } catch (error) {
            // Log specific errors, often related to permissions or invalid URLs
            console.error(`Error getting cookie for ${url}:`, error.message);
            // Don't log to UI for every failed attempt, only if all fail
        }
    }
     if (!apiToken) {
         logAndSend("Failed to retrieve API token. Ensure 'cookies' permission is granted and host permissions match the site's cookie domain.");
     }
}


async function getCurrentHost() {
    if (activeTabId) {
        try {
            const tab = await chrome.tabs.get(activeTabId);
            if (tab?.url) {
                const url = new URL(tab.url);
                // More specific matching
                if (url.hostname.endsWith('stake.com') || url.hostname.endsWith('stake.games') || url.hostname.endsWith('stake.bet') || url.hostname.endsWith('primedice.com')) {
                    return url.hostname;
                }
            }
        } catch (error) { console.error("Error getting tab URL:", error); }
    }
    // Fallback: Query active tab
     try {
        let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
         if (tab?.url) {
             const url = new URL(tab.url);
             if (url.hostname.endsWith('stake.com') || url.hostname.endsWith('stake.games') || url.hostname.endsWith('stake.bet') || url.hostname.endsWith('primedice.com')) {
                 if (tab.id) activeTabId = tab.id; // Update active tab ID if found this way
                 return url.hostname;
             }
         }
     } catch (e) { console.error("Error querying active tab:", e); }

    console.warn("Cannot determine active host.");
    return null;
}
async function getCurrentHostDomain() {
     const host = await getCurrentHost();
     if (!host) return null;
     const parts = host.split('.');
     // Handle cases like stake.com, stake.games, www.stake.com
     if (parts.length >= 2) {
          // Return the main domain part (e.g., stake.com, primedice.com)
          let domain = parts.slice(-2).join('.');
          // Special case for things like stake.co.uk? Add if needed.
          return domain;
     }
     return host;
}

// --- Communication Helpers ---
function sendMessageToContentScript(message) {
    if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, message, (response) => {
            if (chrome.runtime.lastError) {
                // Reduce console noise for common errors when tab is closed/reloading
                if (!chrome.runtime.lastError.message.includes("Could not establish connection") && !chrome.runtime.lastError.message.includes("Receiving end does not exist")) {
                     console.error("BG SendMessage Error:", chrome.runtime.lastError.message);
                }
                // If the bot is running and connection is lost, stop it
                if (isRunning && (chrome.runtime.lastError.message.includes("Could not establish connection") || chrome.runtime.lastError.message.includes("Receiving end does not exist"))) {
                     console.warn("Content script connection lost while running.");
                     stopBot("Content script connection lost");
                }
            }
        });
    } else { console.warn("Cannot send message to CS: No active tab ID."); }
}
function logAndSend(logMessage) { console.log(logMessage); sendMessageToContentScript({ action: "log_message", data: { log: logMessage } }); }
function sendAlertToContentScript(alertText) { sendMessageToContentScript({ action: "alert_message", data: { text: alertText } }); }
function sendStateToContentScript() {
    const state = {
        running: isRunning, profit_total: profitTotal, wagered: wageredTotal, wins: wins, losses: losses,
        currentstreak: currentStreak, currentBetCount: currentBetCount, time: getTimerString(),
        profitPerc: (botSettings.started_bal > 0) ? (profitTotal / botSettings.started_bal * 100) : 0,
        wageredX: (botSettings.started_bal > 0) ? (wageredTotal / botSettings.started_bal) : 0,
    };
    sendMessageToContentScript({ action: "update_ui_stats", data: state });
    sendMessageToContentScript({ action: "set_running_state", data: { running: isRunning } });
}
function sendBalanceToContentScript() { sendMessageToContentScript({ action: "update_balance", data: { balance: currentBalance, currency: currentCurrency } }); }
function sendSettingsToContentScript() { sendMessageToContentScript({ action: "load_settings_ui", data: botSettings }); }

// --- Timer Functions ---
function startTimer() { stopTimer(); timerInterval = setInterval(() => { if (isRunning) sendStateToContentScript(); }, 1000); } // Send full state which includes time
function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }
function getTimerString() { if (!isRunning || !startTime) return "0:00:00:00"; const pt = Date.now() - startTime.getTime(); const ts = Math.floor(pt / 1000); const s = String(ts % 60).padStart(2, '0'); const tm = Math.floor(ts / 60); const m = String(tm % 60).padStart(2, '0'); const th = Math.floor(tm / 60); const h = String(th % 24).padStart(2, '0'); const d = Math.floor(th / 24); return `${d}:${h}:${m}:${s}`; }

// --- Initial Load ---
loadSettingsFromStorage(); // Load settings when the service worker initially starts
