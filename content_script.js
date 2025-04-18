/**
 * Content Script for Dice Bot Extension (v0.2.0 - Custom Scripting)
 * - Injects the UI onto the page.
 * - Loads ACE Editor via script tags.
 * - Listens for user interactions with the UI.
 * - Communicates with the background script (background.js) for logic and state.
 */

console.log("Dice Bot Content Script Loaded (v0.2.0)!");

// --- Global Vars ---
let customScriptEditor = null; // ACE Editor instance
let aceLoaded = false;
let initialSettingsPending = true; // Flag to check if initial settings are loaded

// --- UI Injection ---

// Updated HTML to include Custom Script Panel
const uiHTML = `
<div id="wdb-window">
  <div id="wdb-toolbar">
    <div class="top">
      <div id="lights"> <div class="wdb-light wdb-red"></div> <div class="wdb-light wdb-yellow"></div> <div class="wdb-light wdb-green"></div> </div>
      <div id="wdb-title">Dice Bot v3 - Custom Script</div>
    </div>
  </div>
  <div id="wdb-body">
    <div id="wdb-result">---</div>
    <table class="wdb-tbl">
      <tbody>
        <tr>
          <td class="wdb-col-stats">
            <ul class="wdb-stats-list">
              <li class="clearfix"><span class="float-left">Balance:</span> <span class="float-right"><span id="wdbBalance">?.??</span></span></li>
              <li class="clearfix"><span class="float-left">Profit:</span> <span class="float-right" id="wdbWrapPercentProfit">(<span id="wdbPercentProfit">0.00</span>%) <span id="wdbProfit">0.00</span></span></li>
              <li class="clearfix"><span class="float-left">Wagered:</span> <span class="float-right" id="wdbWrapPercentWagered">(<span id="wdbPercentWagered">0.00</span>x) <span id="wdbWagered">0.00</span></span></li>
              <li class="clearfix"><span class="float-left">W/L:</span> <span class="float-right"><span id="wdbBets">0 / 0</span></span></li>
              <li class="clearfix"><span class="float-left">Streak:</span> <span class="float-right"><span id="wdbStreak">0</span></span></li>
              <li class="clearfix"><span class="float-left">Time:</span> <span class="float-right"><span id="wdbTime">0:00:00:00</span></span></li>
            </ul>
            <div id="wdbControlMenu">
              <div id="wdbMenu">
                <div>
                  <button id="wdbStartButton" class="btn-grad btn-control">Start</button>
                  <button id="wdbStopButton" class="btn-grad btn-control" disabled>Stop</button><br>
                  <button id="resetStatsButton" class="btn-grad">Reset Stats</button>
                  <button id="checkBalanceButton" class="btn-grad">Check Bal</button>
                  <button id="resetSeedButton" class="btn-grad">Reset Seed</button>
                </div>
                 <div id="standardStrategySettings">
                    <div>
                      <label for="baseBetInput">Base Bet:</label>
                      <input type="number" id="baseBetInput" value="0.00000001" step="0.00000001">
                      <button id="halfBetButton" class="btn-grad bet-adjust-btn" title="Halve Base Bet">½</button>
                      <button id="doubleBetButton" class="btn-grad bet-adjust-btn" title="Double Base Bet">2x</button>
                      <br>
                      <label for="chanceInput">Chance (%):</label>
                      <input type="number" id="chanceInput" value="49.5" step="0.01" min="0.01" max="99.99" style="width: 60px;">
                      <label for="betHighInput">Bet High:</label>
                      <label class="switch"> <input id="betHighInput" type="checkbox" checked> <span class="slider round"></span> </label>
                    </div>
                    </div>
                <div>
                  <label for="stopOnProfitInput" title="Stops bot if Profit >= this value. 0 = disabled.">Stop Profit >=:</label>
                  <input type="number" id="stopOnProfitInput" value="0" step="0.00000001" min="0"><br>
                  <label for="stopOnLossInput" title="Stops bot if Profit <= negative this value (e.g., enter 100 to stop at -100 profit). 0 = disabled.">Stop Loss <=:</label>
                  <input type="number" id="stopOnLossInput" value="0" step="0.00000001" min="0"><br>
                  <label for="numberOfBetsInput" title="Stops bot after this many bets. 0 = infinite.">Stop Bets =:</label>
                  <input type="number" id="numberOfBetsInput" value="0" step="1" min="0" style="width: 70px;">
                </div>
                 <div>
                  <label for="wdbMenuCoin">Coin:</label>
                  <select id="wdbMenuCoin"> <option value="btc">BTC</option> </select>
                  <label for="themebot">Theme:</label>
                  <select id="themebot"> <option value="light">light</option> <option value="dark">dark</option> <option value="blue">blue</option> <option value="black">black</option> </select>
                </div>
                <div id="customScriptContainer">
                    <hr style="border: none; border-top: 1px dashed #ccc; margin: 10px 0;">
                    <label class="custom-script-label" for="useCustomScriptInput">Use Custom Strategy Script:</label>
                    <label class="switch">
                        <input type="checkbox" id="useCustomScriptInput">
                        <span class="slider round"></span>
                    </label>
                    <span class="custom-script-warning"><b>WARNING:</b> Enabling this executes the code below. Use ONLY trusted code!</span>
                    <div id="customScriptEditor"></div>
                    <button id="saveScriptButton" class="btn-grad" style="margin-top: 5px;">Save Script</button>
                </div>
              </div>
            </div>
          </td>
          <td class="wdb-col-history">
            <div id="wdbWrapHistory">
              <table>
                <thead> <tr> <th>#</th><th>Game</th><th>Amount</th><th>Hi/Lo</th><th>Target</th><th>Roll</th><th>Profit</th><th>BetID</th> </tr> </thead>
                <tbody id="wdbHistory"></tbody>
              </table>
            </div>
            <div id="wdbWrapLog">
              <table id="wdbLog"> <tbody> <tr><td>Loading UI...</td></tr> </tbody> </table>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</div>
`;

// Updated CSS to include styles for editor panel
const uiCSS = `
/* --- Base Styles (Same as v2.0) --- */
#wdb-window{ display:block; height: 650px; /* Adjusted height */ width: 950px; min-width: 500px; color: black; background: #f0eded; border-radius: 5px; box-shadow: 0px 0px 20px rgba(0,0,0,0.75); overflow: hidden; font-family: Verdana, sans-serif; font-weight: bold; position: fixed; z-index: 9999; left: 50%; top: 50%; transform: translate(-50%, -50%); border: 1px solid #aaa; }
#wdb-toolbar{ width: 100%; height: 25px; background: #cfcfcf; background: linear-gradient(top, #cfcfcf 0%, #a8a8a8 100%); box-shadow:0px 1px 0px rgba(255,255,255,0.5) inset,0px 1px 0px #515151; cursor: move; border-bottom: 1px solid #888; border-radius:5px 5px 0 0;}
#wdb-toolbar .top{ float: left; width: 100%; height: 23px; } #wdb-toolbar #lights{ float: left; position:relative; top:4px; left:7px; }
.wdb-light{ float:left; width:14px; height:14px; border-radius:14px; box-shadow:0px 1px 0px rgba(255,255,255,0.5),0px 0px 3px #000 inset; overflow: hidden; margin-right: 7px; }
.wdb-red{ background: #f41b16; background: linear-gradient(top, #f41b16 0%,#fc7471 100%); } .wdb-yellow{ background: #f4a316; background: linear-gradient(left, #f4a316 0%,#fcc371 100%); } .wdb-green{ background: #4cae2e; background: linear-gradient(top, #4cae2e 0%,#dafc71 100%); }
#wdb-title{ position: relative; top:4px; width: calc(100% - 100px); float: left; text-align: center; font-family: "Myriad Pro", sans-serif; font-size: 14px; text-shadow: 0px 1px 0px rgba(255,255,255,0.5); line-height: 14px; color: #444; }
#wdb-body { font-family: Verdana, sans-serif; line-height: 1em; font-size:13px; float: left; width: calc(100% - 20px); background:#f0eded; padding:10px; line-height:1.5em; height: calc(100% - 45px); overflow-y: auto; }
#wdb-result { padding: 5px 20px 10px; height: 40px; text-align: center; vertical-align: middle; font-size: 30px; font-weight: bold; }
.wdb-tbl{ width: 100%; border-collapse: collapse; } .wdb-tbl td { vertical-align: top; padding: 5px; }
.wdb-col-stats { width: 40%; } /* Adjusted width */
.wdb-col-history { width: 60%; } /* Adjusted width */
.wdb-stats-list li { font-size: 14px; font-weight: bold; list-style: none; white-space: nowrap; overflow:hidden; margin-bottom: 5px; }
.clearfix::after { content: ""; clear: both; display: table; } .float-left { float: left!important; } .float-right { float: right!important; }
#wdbWrapHistory { height: 350px; /* Adjusted height */ padding: 3px; overflow-x: auto; overflow-y: scroll; border: 1px solid #ccc; }
#wdbWrapHistory table { border-collapse: collapse; font-size: 11px!important; width: 100%; } #wdbWrapHistory table thead tr th { text-align: left; padding: 2px 4px; border: 1px solid #fff; background: #e0e0e0; position: sticky; top: 0; z-index: 1; }
#wdbHistory tr { border-bottom: 1px solid #fff; color: #000!important; } #wdbHistory tr:last-child { border-bottom: 1px solid #ccc; }
#wdbHistory tr td { white-space: nowrap; padding: 1.5px 4px; border-right: 1px solid #fff; border-left: 1px solid #fff; } #wdbHistory tr td:first-child { border-left: 1px solid #ccc; } #wdbHistory tr td:last-child { border-right: 1px solid #ccc; }
#wdbHistory tr.win-row { background-color: #91F190; } #wdbHistory tr.loss-row { background-color: #FFC0CB; }
#wdbWrapLog { height: 130px; /* Adjusted height */ overflow-y: scroll; border: 1px solid #ccc; padding: 2px; margin-top: 10px; }
#wdbLog { border-spacing: 0px; table-layout: fixed; font-size: 11px; background: #f0eded; word-wrap: break-word; text-align: left; width: 100%; } #wdbLog td, #wdbLog tr { word-wrap: break-word; text-align: left; padding: 1px 3px; border-bottom: 1px solid #eee; vertical-align: top; }
#wdbControlMenu { padding-top: 5px; } #wdbMenu { padding: 3px; }
#wdbMenu > div { margin-bottom: 8px; padding-bottom: 5px; border-bottom: 1px dashed #ccc;} #wdbMenu > div:last-child { border-bottom: none; }
#wdbMenu label, #wdbMenu span { display: inline-block; margin: 3px 5px 3px 0; vertical-align: middle; }
#wdbMenu input[type=number] { width: 90px; }
#wdbMenu select, #wdbMenu input[type=number], #wdbMenu input[type=checkbox] { background: #fff!important; padding: 4px 6px; border: 1px solid #ccc; border-radius: 3px; margin: 3px 5px 3px 0; vertical-align: middle;}
#wdbMenu .bet-adjust-btn { padding: 1px 5px; font-size: 10px; height: 28px; min-width: 28px; line-height: 1; vertical-align: middle; margin-left: -5px; margin-right: 5px;}
.btn-grad { cursor: pointer; background-image: linear-gradient(to right, #00E701 0%, #00E701 51%, #00E701 100%); text-align: center; transition: 0.5s; background-size: 200% auto; border: 1px solid #ccc; border-radius: 3px; font-weight: bold; font-size: 13px; padding: 6px 12px; margin: 3px; color: black; }
.btn-grad:hover { background-position: right center; text-decoration: none; } .btn-grad:active { opacity: .65; } .btn-grad:disabled { cursor: auto; opacity: .65; color: #666 !important; background-image: linear-gradient(to right, #ccc 0%, #ccc 100%) !important; }
.btn-control { padding-top: 10px!important; padding-bottom: 10px!important; width: 110px; }
.switch { position: relative; display: inline-block; width: 40px; height: 19px; vertical-align: middle;} .switch input { opacity: 0; width: 0; height: 0; }
.slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; } .slider:before { position: absolute; content: ""; height: 15px; width: 15px; left: 2px; bottom: 2px; background-color: black; transition: .4s; }
input:checked + .slider { background-image: linear-gradient(to right, #00E701 0%, #00E701 51%, #00E701 100%); } input:checked + .slider:before { transform: translateX(20px); }
.slider.round { border-radius: 19px; } .slider.round:before { border-radius: 50%; }
/* --- Custom Scripting Panel Styles --- */
#customScriptContainer { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #ccc; }
#customScriptEditor { height: 120px; /* Adjusted height */ width: 100%; border: 1px solid #ccc; border-radius: 3px; }
.custom-script-label { font-weight: bold; margin-bottom: 5px; display: block; }
.custom-script-warning { color: #f72a42; font-size: 10px; display: block; margin-top: 3px; }
#standardStrategySettings[disabled], #standardStrategySettings [disabled] { /* Style for disabled standard settings */
    opacity: 0.5;
    pointer-events: none;
    cursor: not-allowed;
}

/* --- Theme Adjustments --- */
.dark-theme #wdb-window, .dark-theme #wdb-body, .dark-theme #wdbLog { background: #383838; color: white; border-color: #555; } .dark-theme #wdb-toolbar { background: #555; border-bottom-color: #333; } .dark-theme #wdb-title { color: #eee; text-shadow: none; } .dark-theme #wdbWrapHistory, .dark-theme #wdbWrapLog, .dark-theme #wdbMenu select, .dark-theme #wdbMenu input[type=number], .dark-theme #wdbMenu input[type=checkbox] { border-color: #555; background: #444 !important; color: white; } .dark-theme #wdbWrapHistory table thead tr th { background: #444; color: white; border-color: #555; } .dark-theme #wdbHistory tr { border-color: #555; color: white !important; } .dark-theme #wdbHistory tr.win-row { background-color: #005000; } .dark-theme #wdbHistory tr.loss-row { background-color: #58181F; } .dark-theme #wdb-result { color: white; } .dark-theme .btn-grad { border-color: #777; color: white; } .dark-theme .btn-grad:disabled { border-color: #555 !important; color: #aaa !important; background-image: linear-gradient(to right, #555 0%, #555 100%) !important; } .dark-theme #wdbLog td { border-color: #555; } .dark-theme .slider { background-color: #555; } .dark-theme .slider:before { background-color: #ddd; } .dark-theme input:checked + .slider { background-image: linear-gradient(to right, #008f00 0%, #00a700 51%, #00c300 100%); }
.dark-theme #customScriptContainer { border-top-color: #555; } .dark-theme #customScriptEditor { border-color: #555; }

.blue-theme #wdb-window, .blue-theme #wdb-body, .blue-theme #wdbLog { background: #213743; color: white; border-color: #4a6a7f; } .blue-theme #wdb-toolbar { background: #3a5f7e; border-bottom-color: #2c4a5f; } .blue-theme #wdb-title { color: #eee; text-shadow: none; } .blue-theme #wdbWrapHistory, .blue-theme #wdbWrapLog, .blue-theme #wdbMenu select, .blue-theme #wdbMenu input[type=number], .blue-theme #wdbMenu input[type=checkbox] { border-color: #4a6a7f; background: #2c4a5f !important; color: white; } .blue-theme #wdbWrapHistory table thead tr th { background: #2c4a5f; color: white; border-color: #4a6a7f; } .blue-theme #wdbHistory tr { border-color: #4a6a7f; color: white !important; } .blue-theme #wdbHistory tr.win-row { background-color: #1a6853; } .blue-theme #wdbHistory tr.loss-row { background-color: #78283f; } .blue-theme #wdb-result { color: white; } .blue-theme .btn-grad { border-color: #777; color: white; } .blue-theme .btn-grad:disabled { border-color: #5a7a8f !important; color: #aaa !important; background-image: linear-gradient(to right, #5a7a8f 0%, #5a7a8f 100%) !important; } .blue-theme #wdbLog td { border-color: #4a6a7f; } .blue-theme .slider { background-color: #4a6a7f; } .blue-theme .slider:before { background-color: #ddd; } .blue-theme input:checked + .slider { background-image: linear-gradient(to right, #008f00 0%, #00a700 51%, #00c300 100%); }
.blue-theme #customScriptContainer { border-top-color: #4a6a7f; } .blue-theme #customScriptEditor { border-color: #4a6a7f; }

.black-theme #wdb-window, .black-theme #wdb-body, .black-theme #wdbLog { background: #000000; color: white; border-color: #333; } .black-theme #wdb-toolbar { background: #222222; border-bottom-color: #111; } .black-theme #wdb-title { color: #eee; text-shadow: none; } .black-theme #wdbWrapHistory, .black-theme #wdbWrapLog, .black-theme #wdbMenu select, .black-theme #wdbMenu input[type=number], .black-theme #wdbMenu input[type=checkbox] { border-color: #333333; background: #111111 !important; color: white; } .black-theme #wdbWrapHistory table thead tr th { background: #111111; color: white; border-color: #333333; } .black-theme #wdbHistory tr { border-color: #333333; color: white !important; } .black-theme #wdbHistory tr.win-row { background-color: #003000; } .black-theme #wdbHistory tr.loss-row { background-color: #400000; } .black-theme #wdb-result { color: white; } .black-theme .btn-grad { border-color: #555; color: white; } .black-theme .btn-grad:disabled { border-color: #444 !important; color: #999 !important; background-image: linear-gradient(to right, #444 0%, #444 100%) !important; } .black-theme #wdbLog td { border-color: #333333; } .black-theme .slider { background-color: #333333; } .black-theme .slider:before { background-color: #ccc; } .black-theme input:checked + .slider { background-image: linear-gradient(to right, #00E701 0%, #00E701 51%, #00E701 100%); }
.black-theme #customScriptContainer { border-top-color: #333; } .black-theme #customScriptEditor { border-color: #333; }
`;

// Function to inject UI and load ACE Editor
function injectUI() {
    if (document.getElementById('wdb-window')) {
        console.log("Dice Bot UI already injected.");
        return;
    }

    // Inject CSS
    const styleSheet = document.createElement("style");
    styleSheet.type = "text/css";
    styleSheet.innerText = uiCSS;
    document.head.appendChild(styleSheet);

    // Inject HTML
    const uiContainer = document.createElement('div');
    uiContainer.innerHTML = uiHTML;
    document.body.appendChild(uiContainer);

    console.log("Dice Bot UI Injected.");

    // Load ACE Editor library via script tags
    // Note: Bundling ACE with the extension is preferred in production
    loadAceEditor(() => {
        initializeAceEditor();
        // Setup listeners and get initial state AFTER editor is ready
        setupUIEventListeners();
        sendMessageToBackground({ action: "get_initial_state" }); // Request state again now editor is ready
    });
}

// Function to dynamically load ACE editor scripts
function loadAceEditor(callback) {
    if (typeof ace !== 'undefined') { // Check if already loaded
        console.log("ACE already loaded.");
        aceLoaded = true;
        if (callback) callback();
        return;
    }
    if (document.getElementById('ace-editor-script-loader')) {
        console.log("ACE loading already in progress...");
        // Optionally wait or poll for ace object
        return;
    }

    console.log("Loading ACE Editor scripts...");
    const loaderDiv = document.createElement('div'); // Use a div to load scripts sequentially
    loaderDiv.id = 'ace-editor-script-loader';
    loaderDiv.style.display = 'none';
    document.body.appendChild(loaderDiv);

    const base = "https://cdnjs.cloudflare.com/ajax/libs/ace/1.15.2/";
    const scriptsToLoad = [
        "ace.js",
        "mode-javascript.js",
        "theme-chrome.js",
        "theme-tomorrow_night.js",
        "theme-cobalt.js"
    ];
    let loadedCount = 0;

    function loadNextScript() {
        if (loadedCount >= scriptsToLoad.length) {
            console.log("All ACE scripts loaded.");
            aceLoaded = true;
            document.body.removeChild(loaderDiv); // Clean up loader div
            if (typeof ace !== 'undefined') {
                if (callback) callback();
            } else {
                console.error("ACE object not found after loading scripts!");
                logToUI("Error: Failed to initialize code editor.");
            }
            return;
        }

        const src = scriptsToLoad[loadedCount];
        const script = document.createElement('script');
        script.src = base + src;
        script.onload = () => {
            console.log(`Loaded ${src}`);
            loadedCount++;
            loadNextScript(); // Load the next script
        };
        script.onerror = () => {
            console.error(`Failed to load ACE script: ${src}`);
            logToUI(`Error: Failed to load code editor component (${src}).`);
            document.body.removeChild(loaderDiv); // Clean up on error
        };
        loaderDiv.appendChild(script); // Append to trigger loading
    }

    loadNextScript(); // Start loading the first script
}


// Function to initialize the ACE editor instance
function initializeAceEditor() {
     if (!aceLoaded || typeof ace === 'undefined') {
         console.error("ACE library not ready for initialization.");
         return;
     }
     if (customScriptEditor) { // Avoid re-initializing
         console.log("ACE editor already initialized.");
         return;
     }
     try {
         const editorElement = document.getElementById('customScriptEditor');
         if (!editorElement) throw new Error("Editor element not found in DOM");

         customScriptEditor = ace.edit(editorElement);
         customScriptEditor.session.setMode("ace/mode/javascript");
         customScriptEditor.setOptions({
             fontSize: "10pt",
             useWorker: false, // Disable workers for simplicity
             showPrintMargin: false
         });
         // Theme is set by applyTheme/loadSettingsToUI
         console.log("ACE editor initialized.");

         // Load initial script content *after* initialization is confirmed
         // This is now handled by the loadSettingsToUI call triggered by get_initial_state
         // sendMessageToBackground({ action: "get_initial_state" });

     } catch (e) {
         console.error("ACE Editor Init Failed:", e);
         logToUI(`Error: Failed to initialize code editor instance: ${e.message}`);
         customScriptEditor = null;
     }
}


// --- Communication with Background Script --- (Same as before)
function sendMessageToBackground(message) {
    if (!chrome.runtime?.id) { console.error("Extension context invalidated."); logToUI("Error: Extension context lost."); return; }
    chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) { console.error("CS SendMessage Error:", chrome.runtime.lastError.message); if (chrome.runtime.lastError.message.includes("Receiving end does not exist")) { logToUI("Error: Connection to background lost. Reload?"); } }
        else { if (response && response.status === 'error') { console.error("Background Error Response:", response.message); logToUI(`Error: ${response.message}`); } }
    });
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case "update_ui_stats": updateStatsDisplay(message.data); break;
        case "update_balance": updateBalanceDisplay(message.data.balance, message.data.currency); break;
        case "update_coins": populateCoinSelector(message.data.coins, message.data.selected); break;
        case "log_message": logToUI(message.data.log); break;
        case "set_result": setResultDisplay(message.data.roll, message.data.win); break;
        case "add_history": addHistoryRow(message.data); break;
        case "set_running_state": setRunningState(message.data.running); break;
        case "load_settings_ui": loadSettingsToUI(message.data); break;
        case "alert_message": alert(message.data.text); break;
        case "ping": /* Optional: Respond to keep-alive ping */ sendResponse({ status: "pong" }); break;
    }
    return true;
});

// --- UI Update Functions --- (Mostly same as before)
function logToUI(message) { /* ... */ }
function updateBalanceDisplay(balance, currency) { /* ... */ }
function populateCoinSelector(coins = [], selectedCoin = 'btc') { /* ... */ }
function updateStatsDisplay(stats) { /* ... */ }
function setResultDisplay(roll, win) { /* ... */ }
function addHistoryRow(bet) { /* ... */ }

function setRunningState(isRunning) {
    document.getElementById('wdbStartButton')?.toggleAttribute('disabled', isRunning);
    document.getElementById('wdbStopButton')?.toggleAttribute('disabled', !isRunning);
    document.getElementById('wdbMenuCoin')?.toggleAttribute('disabled', isRunning);
    document.getElementById('themebot')?.toggleAttribute('disabled', isRunning);
    document.getElementById('resetStatsButton')?.toggleAttribute('disabled', isRunning);
    document.getElementById('checkBalanceButton')?.toggleAttribute('disabled', isRunning);
    document.getElementById('resetSeedButton')?.toggleAttribute('disabled', isRunning);
    document.getElementById('useCustomScriptInput')?.toggleAttribute('disabled', isRunning);
    document.getElementById('saveScriptButton')?.toggleAttribute('disabled', isRunning);
    if (customScriptEditor) customScriptEditor.setReadOnly(isRunning);
    const useCustom = document.getElementById('useCustomScriptInput')?.checked ?? false;
    toggleStandardSettings(!isRunning && !useCustom);
}

function loadSettingsToUI(settings) {
    if (!settings) { console.warn("loadSettingsToUI received null settings"); return; }
    initialSettingsPending = false; // Mark that settings have been received
    const setValue = (id, value) => { const el = document.getElementById(id); if (el && value !== undefined) el.value = value; };
    const setChecked = (id, checked) => { const el = document.getElementById(id); if (el && checked !== undefined) el.checked = checked; };

    setValue('baseBetInput', settings.baseBet);
    setValue('chanceInput', settings.chance);
    setChecked('betHighInput', settings.betHigh);
    setValue('wdbMenuCoin', settings.currency);
    setValue('themebot', settings.theme);
    setValue('stopOnProfitInput', settings.stopProfit);
    setValue('stopOnLossInput', settings.stopLoss);
    setValue('numberOfBetsInput', settings.numBets);
    setChecked('useCustomScriptInput', settings.useCustomScript);

    // Load script code into editor *only if* editor is ready
    if (customScriptEditor && settings.customScriptCode !== undefined) {
         customScriptEditor.setValue(settings.customScriptCode || '', -1);
         console.log("Loaded script into ACE editor.");
    } else if (!customScriptEditor && settings.useCustomScript) {
        console.warn("Attempted to load custom script but editor not ready. Will retry on editor init.");
        // The editor init callback will request state again.
    } else if (customScriptEditor && settings.customScriptCode === undefined) {
         // Handle case where setting exists but code doesn't (e.g., first load after update)
         customScriptEditor.setValue('', -1);
    }


    applyTheme(settings.theme || 'light');
    toggleStandardSettings(!settings.useCustomScript);
}


// --- UI Event Listeners Setup ---
function setupUIEventListeners() {
    // Main Controls
    document.getElementById('wdbStartButton')?.addEventListener('click', () => {
        logToUI("Start button clicked...");
        const settings = {
             baseBet: document.getElementById('baseBetInput')?.value,
             chance: document.getElementById('chanceInput')?.value,
             betHigh: document.getElementById('betHighInput')?.checked,
             currency: document.getElementById('wdbMenuCoin')?.value,
             stopProfit: document.getElementById('stopOnProfitInput')?.value,
             stopLoss: document.getElementById('stopOnLossInput')?.value,
             numBets: document.getElementById('numberOfBetsInput')?.value,
             useCustomScript: document.getElementById('useCustomScriptInput')?.checked,
             customScriptCode: customScriptEditor?.getValue() ?? '' // Send current editor content
        };
        sendMessageToBackground({ action: "start_bot", data: settings });
    });
    document.getElementById('wdbStopButton')?.addEventListener('click', () => sendMessageToBackground({ action: "stop_bot" }));
    document.getElementById('resetStatsButton')?.addEventListener('click', () => sendMessageToBackground({ action: "reset_stats" }));
    document.getElementById('checkBalanceButton')?.addEventListener('click', () => sendMessageToBackground({ action: "check_balance" }));
    document.getElementById('resetSeedButton')?.addEventListener('click', () => sendMessageToBackground({ action: "reset_seed" }));

    // Settings Controls
    const inputsToSave = [ 'baseBetInput', 'chanceInput', 'betHighInput', 'stopOnProfitInput', 'stopOnLossInput', 'numberOfBetsInput' ];
    inputsToSave.forEach(id => {
        document.getElementById(id)?.addEventListener('change', (e) => {
            const value = (e.target.type === 'checkbox') ? e.target.checked : e.target.value;
            sendMessageToBackground({ action: "save_setting", data: { key: id, value: value } });
        });
    });
    document.getElementById('wdbMenuCoin')?.addEventListener('change', (e) => sendMessageToBackground({ action: "save_setting", data: { key: 'currency', value: e.target.value } }));
    document.getElementById('themebot')?.addEventListener('change', (e) => {
         applyTheme(e.target.value);
         sendMessageToBackground({ action: "save_setting", data: { key: 'theme', value: e.target.value } });
     });

    // Bet adjust buttons
    document.getElementById('halfBetButton')?.addEventListener('click', () => { const input = document.getElementById('baseBetInput'); if (input) { let cv = parseFloat(input.value) || 0.00000002; input.value = Math.max(0.00000001, cv / 2).toFixed(8); input.dispatchEvent(new Event('change')); } });
    document.getElementById('doubleBetButton')?.addEventListener('click', () => { const input = document.getElementById('baseBetInput'); if (input) { let cv = parseFloat(input.value) || 0.00000001; input.value = (cv * 2).toFixed(8); input.dispatchEvent(new Event('change')); } });

    // Custom Script Controls
    const ucsInput = document.getElementById('useCustomScriptInput');
    if (ucsInput) {
        ucsInput.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            toggleStandardSettings(!isChecked);
            sendMessageToBackground({ action: "save_setting", data: { key: 'useCustomScript', value: isChecked } });
            logToUI(`Custom script usage ${isChecked ? 'enabled' : 'disabled'}.`);
        });
    }
    document.getElementById('saveScriptButton')?.addEventListener('click', () => {
        if (customScriptEditor) {
            const code = customScriptEditor.getValue();
            sendMessageToBackground({ action: "save_setting", data: { key: 'customScriptCode', value: code } });
            logToUI("Custom script content sent to background for saving.");
        } else { logToUI("Error: Cannot save script, editor not initialized."); }
    });

    // Make window draggable
    makeDraggable();
}

// Helper to toggle standard strategy settings
function toggleStandardSettings(enable) {
    const container = document.getElementById('standardStrategySettings');
    if (container) {
        container.toggleAttribute('disabled', !enable); // Use attribute for styling hook
        // Style is handled by CSS rule now
        // container.style.opacity = enable ? '1' : '0.5';
        // container.style.pointerEvents = enable ? 'auto' : 'none';
        const idsToToggle = [ 'baseBetInput', 'chanceInput', 'betHighInput', 'halfBetButton', 'doubleBetButton' ];
        idsToToggle.forEach(id => {
            document.getElementById(id)?.toggleAttribute('disabled', !enable);
        });
    }
}


// --- Theme and Dragging Logic --- (Copied from previous version)
function getThemeColors(tName) { const themes={light:{className:'light-theme',profitColor:'green'},dark:{className:'dark-theme',profitColor:'#05f711'},blue:{className:'blue-theme',profitColor:'#05f711'},black:{className:'black-theme',profitColor:'#00E701'}}; return themes[tName]||themes.light; }
function applyTheme(selTheme) {
    const winEl=document.getElementById('wdb-window'); if(!winEl)return;
    const themeSet=getThemeColors(selTheme);
    winEl.classList.remove('light-theme','dark-theme','blue-theme','black-theme');
    winEl.classList.add(themeSet.className);
    const currentProfit = parseFloat(document.getElementById("wdbProfit")?.textContent || '0');
    const profEl=document.getElementById("wdbProfit"), profPctEl=document.getElementById("wdbWrapPercentProfit")?.querySelector("span:first-child");
    const curProfCol= currentProfit < 0 ? "#f72a42" : themeSet.profitColor;
    if(profEl) profEl.style.color=curProfCol;
    if(profPctEl) profPctEl.style.color=curProfCol;
     if (customScriptEditor) {
         let aceTheme = 'ace/theme/chrome';
         if (selTheme === 'dark' || selTheme === 'black') aceTheme = 'ace/theme/tomorrow_night';
         else if (selTheme === 'blue') aceTheme = 'ace/theme/cobalt';
         try { customScriptEditor.setTheme(aceTheme); } catch(e) { console.error("Failed to set ACE theme:", e); }
     }
}
function makeDraggable() { const tb=document.getElementById("wdb-toolbar"), we=document.getElementById('wdb-window'); if(!tb||!we){console.warn("Drag elements missing.");return;} let drag=false,ix,iy,ox,oy; const md=(e)=>{if(e.target===tb||e.target.classList.contains('top')){const lr=document.getElementById('lights')?.getBoundingClientRect();if(lr&&e.clientX>=lr.left&&e.clientX<=lr.right&&e.clientY>=lr.top&&e.clientY<=lr.bottom){return;} drag=true;ix=e.clientX;iy=e.clientY; const st=window.getComputedStyle(we);let cl=parseFloat(st.left),ct=parseFloat(st.top);const mx=new DOMMatrixReadOnly(st.transform);if(mx.m41!==0||mx.m42!==0){cl=(window.innerWidth-we.offsetWidth)/2+mx.m41;ct=(window.innerHeight-we.offsetHeight)/2+mx.m42;we.style.transform='none';we.style.left=`${cl}px`;we.style.top=`${ct}px`;} ox=ix-cl;oy=iy-ct;tb.style.cursor='grabbing';document.body.style.userSelect='none';document.addEventListener('mousemove',mm);document.addEventListener('mouseup',mu);}}; const mm=(e)=>{if(!drag)return; let nx=e.clientX-ox,ny=e.clientY-oy;nx=Math.max(0,Math.min(nx,window.innerWidth-we.offsetWidth));ny=Math.max(0,Math.min(ny,window.innerHeight-we.offsetHeight));we.style.left=`${nx}px`;we.style.top=`${ny}px`;}; const mu=()=>{if(drag){drag=false;tb.style.cursor='move';document.body.style.userSelect='';document.removeEventListener('mousemove',mm);document.removeEventListener('mouseup',mu);}}; tb.addEventListener('mousedown',md); }


// --- Initial Execution ---
// Inject UI first, then load ACE and setup listeners in the callback
injectUI();
