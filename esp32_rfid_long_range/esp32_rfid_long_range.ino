/*
 * =====================================================================================
 * CHARRMPASS — ESP32 Long-Range UHF RFID Gateway + BLE Wi-Fi Provisioning v4.5
 * =====================================================================================
 *
 * 1. BLUETOOTH (BLE) WI-FI PROVISIONING:
 *    - Phone/Web Browser connects over BLE (Service: 4fafc201-..., Char: beb5483e-...).
 *    - Sends Wi-Fi SSID & Password directly to ESP32 without typing code.
 *    - Credentials saved permanently in ESP32 Flash Memory (NVS Preferences).
 *    - If Wi-Fi fails to connect, BLE automatically starts in Setup Mode.
 *
 * 2. SINGLE LONG-RANGE UHF RFID (AUTO ENTRY & EXIT):
 *    - Automatically detects if vehicle is currently inside or outside campus.
 *    - If inside -> Logs "EXIT" and opens gate.
 *    - If outside -> Logs "ENTRY" and opens gate.
 *    - 6-second anti-collision debounce suppresses repeat scans while car passes.
 *
 * 3. HARDWARE PINOUT:
 *    - Long-Range UHF Reader (UART): TX -> GPIO 16 (RX2), RX -> GPIO 17 (TX2)
 *    - 16x2 I2C LCD: SDA (GPIO 21), SCL (GPIO 22)
 *    - Relay / Boom Barrier Gate: GPIO 25 (Active LOW)
 *    - Status LEDs: Green (GPIO 4), Red (GPIO 2)
 *    - Active Buzzer: GPIO 15
 *    - MicroSD Card (HSPI): CS (GPIO 13), SCK (GPIO 26), MISO (GPIO 14), MOSI (GPIO 12)
 * =====================================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>
#include <SPI.h>
#include <MFRC522.h>
#include <SD.h>
#include <FS.h>
#include <Preferences.h>
#include <esp_wifi.h>   // for esp_wifi_set_ps(WIFI_PS_NONE)

// BLE Libraries
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// =====================================================
// 1. GATE IDENTIFIERS & BLE UUIDS (Standard 128-bit custom UUIDs)
// =====================================================
#define GATE_ID              "CHARRMPASS_UHF_SINGLE_GATE"
#define GATE_CATEGORY        "VEHICLE_BARRIER"
#define RFID_RANGE_MODE      "LONG_RANGE"

// BLE Service & Characteristic UUIDs (Matches CHARRMPASS Web App)
#define BLE_SERVICE_UUID     "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define BLE_CHAR_UUID        "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define BLE_DEVICE_NAME      "CHARRMPASS_ESP32_GATE"

// Hardware Pin Configuration — Boland UHF Reader (Wiegand)
#define ENABLE_WIEGAND       true
#define WIEGAND_D0_PIN       32   // Primary Data 0 (Purple wire with internal pull-up)
#define WIEGAND_D0_PIN_ALT   35   // Secondary Data 0 (In case Purple wire is connected to GPIO 35)
#define WIEGAND_D1_PIN       33   // Data 1 (White wire with internal pull-up)

// Interrupt-safe Wiegand pulse buffer with microsecond noise filtering
volatile uint64_t wiegandRawBits = 0;
volatile int wiegandBitCount = 0;
volatile uint32_t wiegandLastPulseUs = 0;
volatile uint32_t wiegandTotalPulses = 0;

void IRAM_ATTR isrWiegandD0() {
  uint32_t now = micros();
  // Filter only ultra-high frequency spikes (< 20 microseconds).
  // DO NOT use 250us because Boland UHF reader pulse interval is ~100us!
  if (now - wiegandLastPulseUs < 20) return;
  wiegandLastPulseUs = now;
  wiegandTotalPulses++;
  if (wiegandBitCount < 64) {
    wiegandRawBits <<= 1;
    wiegandBitCount++;
  } else {
    // Noise overflow: reset
    wiegandBitCount = 0;
    wiegandRawBits = 0;
  }
}

void IRAM_ATTR isrWiegandD1() {
  uint32_t now = micros();
  if (now - wiegandLastPulseUs < 20) return;
  wiegandLastPulseUs = now;
  wiegandTotalPulses++;
  if (wiegandBitCount < 64) {
    wiegandRawBits = (wiegandRawBits << 1) | 1ULL;
    wiegandBitCount++;
  } else {
    // Noise overflow: reset
    wiegandBitCount = 0;
    wiegandRawBits = 0;
  }
}

#define ENABLE_SPI_MFRC522   true
#define RFID_SS_PIN          5
#define RFID_RST_PIN         27

#define SD_CS_PIN            13
#define SD_MOSI_PIN          12
#define SD_MISO_PIN          14
#define SD_SCK_PIN           26

#define RELAY_PIN            25   // Boom barrier gate relay
#define GREEN_LED            4
#define RED_LED              2
#define BUZZER_PIN           15

// =====================================================
// 2. SUPABASE CLOUD REST API
// =====================================================
const char* SUPABASE_URL = "https://sdwjkgtxrpeajuymgpxp.supabase.co";
const char* SUPABASE_ANON =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkd2prZ3R4cnBlYWp1eW1ncHhwIiwicm9sZSI6Im"
    "Fub24iLCJpYXQiOjE3ODgxMDA0ODEsImV4cCI6MjEwMzY3NjQ4MX0.ZLloaPDBQTMj_"
    "OMTgr5BX6VHqEK7Nc0bFnB7b35d4PA";

// =====================================================
// 3. GLOBAL OBJECTS & STATE
// =====================================================
hd44780_I2Cexp lcd;
MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
SPIClass spiSD(HSPI);
Preferences preferences;

// BLE Server handles
BLEServer* pBleServer = NULL;
BLECharacteristic* pBleCharacteristic = NULL;
bool bleClientConnected = false;
bool bleServerRunning = false;
bool newWifiCredentialsReceived = false;

// Wi-Fi credentials are NEVER hardcoded.
// They are loaded exclusively from NVS (saved via Captive Portal or BLE).
String currentSsid = "";
String currentPass = "";

bool wifiConnected = false;
bool sdCardReady   = false;
unsigned long lastHeartbeat = 0;
const unsigned long HEARTBEAT_INTERVAL = 60000; // 60 seconds periodic health check

const char* WHITELIST_FILE   = "/uhf_whitelist.csv";
const char* INSIDE_LIST_FILE = "/currently_inside.csv";
const char* OFFLINE_TX_FILE  = "/offline_txns.csv";
const char* WIFI_CONFIG_FILE = "/config/wifi.cfg";  // SD Wi-Fi backup

// =====================================================
// MULTI-TAG ANTI-SPAM & COOLDOWN TRACKER
// Allows reading multiple distinct tags simultaneously
// while preventing duplicate spam loops on any single tag.
// =====================================================
struct RecentTagRecord {
  String uid;
  unsigned long timestamp;
};
#define MAX_RECENT_TAGS 16
RecentTagRecord recentTags[MAX_RECENT_TAGS];
int recentTagIdx = 0;
const unsigned long TAG_COOLDOWN_MS = 4000; // 4 seconds per unique tag

bool isTagInCooldown(const String &uid) {
  unsigned long now = millis();
  for (int i = 0; i < MAX_RECENT_TAGS; i++) {
    if (recentTags[i].uid.length() > 0 && recentTags[i].uid.equalsIgnoreCase(uid)) {
      if (now - recentTags[i].timestamp < TAG_COOLDOWN_MS) {
        return true;
      }
    }
  }
  return false;
}

void markTagInCooldown(const String &uid) {
  recentTags[recentTagIdx].uid = uid;
  recentTags[recentTagIdx].timestamp = millis();
  recentTagIdx = (recentTagIdx + 1) % MAX_RECENT_TAGS;
}

// =====================================================
// HIGH-SPEED IN-MEMORY RAM WHITELIST CACHE
// Enables < 0.1ms tag matching with ZERO network delay
// =====================================================
typedef struct {
  String uid;
  String name;
  String plate;
  String role;
  String userType;
  String vehicleId;
  String userId;
  bool authorized;
  String lastDirection; // Auto-toggles: ENTRY -> EXIT -> ENTRY
} RamCard;

#define MAX_RAM_CARDS 128
RamCard ramCards[MAX_RAM_CARDS];
int ramCardCount = 0;
unsigned long lastWhitelistSync = 0;
const unsigned long WHITELIST_SYNC_INTERVAL = 300000; // Auto-sync RAM every 5 minutes

int findCardInRam(const String &uid) {
  for (int i = 0; i < ramCardCount; i++) {
    if (ramCards[i].uid.equalsIgnoreCase(uid)) {
      return i;
    }
  }
  return -1;
}

void addCardToRam(String uid, String name, String plate, String role, String userType, String vId, String uId, bool auth, String dir = "EXIT") {
  int idx = findCardInRam(uid);
  if (idx != -1) {
    ramCards[idx].name = name;
    ramCards[idx].plate = plate;
    ramCards[idx].role = role;
    ramCards[idx].userType = userType;
    ramCards[idx].vehicleId = vId;
    ramCards[idx].userId = uId;
    ramCards[idx].authorized = auth;
    if (dir.length() > 0) ramCards[idx].lastDirection = dir;
    return;
  }
  if (ramCardCount < MAX_RAM_CARDS) {
    ramCards[ramCardCount].uid = uid;
    ramCards[ramCardCount].name = name;
    ramCards[ramCardCount].plate = plate;
    ramCards[ramCardCount].role = role;
    ramCards[ramCardCount].userType = userType;
    ramCards[ramCardCount].vehicleId = vId;
    ramCards[ramCardCount].userId = uId;
    ramCards[ramCardCount].authorized = auth;
    ramCards[ramCardCount].lastDirection = dir;
    ramCardCount++;
  }
}

// =====================================================
// ASYNCHRONOUS BACKGROUND TRANSACTION QUEUE
// Prevents cloud HTTP calls from blocking Wiegand scanning
// =====================================================
struct QueuedTransaction {
  String uid;
  String direction;
  String status;
  String remarks;
  String vehicleId;
  String userId;
  String userType;
};
#define MAX_TX_QUEUE 32
QueuedTransaction txQueue[MAX_TX_QUEUE];
int txQueueHead = 0;
int txQueueTail = 0;
int txQueueCount = 0;

void enqueueTransaction(String uid, String dir, String status, String remarks, String vId, String uId, String uType) {
  if (txQueueCount >= MAX_TX_QUEUE) {
    // Drop oldest to avoid buffer lock
    txQueueHead = (txQueueHead + 1) % MAX_TX_QUEUE;
    txQueueCount--;
  }
  txQueue[txQueueTail].uid = uid;
  txQueue[txQueueTail].direction = dir;
  txQueue[txQueueTail].status = status;
  txQueue[txQueueTail].remarks = remarks;
  txQueue[txQueueTail].vehicleId = vId;
  txQueue[txQueueTail].userId = uId;
  txQueue[txQueueTail].userType = uType;
  txQueueTail = (txQueueTail + 1) % MAX_TX_QUEUE;
  txQueueCount++;
}

// Scan verification state
bool card_found        = false;
bool card_authorized   = false;
String card_name       = "";
String card_plate      = "";
String card_role       = "";
String card_userType   = "VEHICLE";
String card_rfidType   = "LONG_RANGE";
String card_vehicleId  = "";
String card_userId     = "";
String calculatedDirection = "ENTRY";
unsigned long lastTagDisplayMillis = 0;

// Forward declarations
void sendDeviceHeartbeat();
void sendBleStatus(String status);
void syncWhitelistToRam();
void insertTransactionOnline(String uid, String direction, String status, String remarks, String vId = "", String uId = "", String uType = "VEHICLE");

// =====================================================
// 4. LCD & AUDIO HELPERS
// =====================================================
// Fast, flicker-free LCD write without full clear delay
void lcdShowFast(String line1, String line2) {
  char b1[17], b2[17];
  snprintf(b1, sizeof(b1), "%-16.16s", line1.c_str());
  snprintf(b2, sizeof(b2), "%-16.16s", line2.c_str());
  lcd.setCursor(0, 0);
  lcd.print(b1);
  lcd.setCursor(0, 1);
  lcd.print(b2);
  lastTagDisplayMillis = millis();
}

void lcdMsg(String line1, String line2) {
  lcdShowFast(line1, line2);
}

void showReady() {
  digitalWrite(RED_LED, HIGH);
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RELAY_PIN, HIGH); // Relay off

  if (wifiConnected) {
    lcdShowFast("UHF MONITOR RDY", "AUTO DRIVE-THRU");
  } else if (bleServerRunning) {
    lcdShowFast("[BLE SETUP MODE]", "PAIR PHONE/APP");
  } else {
    lcdShowFast("[OFFLINE] READY", "AUTO DRIVE-THRU");
  }
}

void beep(int ms, int count = 1) {
  for (int i = 0; i < count; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(ms);
    digitalWrite(BUZZER_PIN, LOW);
    if (count > 1) delay(40);
  }
}

void triggerBarrier() {
  // Free-flow automated drive-through monitoring (no barrier arm delay)
  digitalWrite(RELAY_PIN, LOW);   // Quick pulse
  digitalWrite(GREEN_LED, HIGH);
  digitalWrite(RED_LED, LOW);
  delay(100);
  digitalWrite(RELAY_PIN, HIGH);
  digitalWrite(GREEN_LED, LOW);
}

String urlEncode(String str) {
  String encoded = "";
  char c;
  for (int i = 0; i < str.length(); i++) {
    c = str.charAt(i);
    if (isalnum(c)) encoded += c;
    else if (c == ' ') encoded += "%20";
    else {
      char code[4];
      sprintf(code, "%%%02X", (unsigned char)c);
      encoded += code;
    }
  }
  return encoded;
}

// =====================================================
// 5. BLUETOOTH (BLE) PROVISIONING CALLBACKS
// =====================================================
void sendBleStatus(String status) {
  if (pBleCharacteristic && bleClientConnected) {
    pBleCharacteristic->setValue(status.c_str());
    pBleCharacteristic->notify();
    Serial.println("[BLE TX NOTIFY] " + status);
  }
}

class BleServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    bleClientConnected = true;
    Serial.println("\n[BLE] Client Connected via Bluetooth!");
    lcdMsg("BLUETOOTH PAIRED", "RECEIVING WIFI...");
    beep(100, 2);
  }

  void onDisconnect(BLEServer* pServer) {
    bleClientConnected = false;
    Serial.println("[BLE] Client Disconnected.");
    // Restart advertising so user can reconnect if needed
    if (bleServerRunning) {
      BLEDevice::startAdvertising();
      showReady();
    }
  }
};

class BleCharCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
    String rxValue = pCharacteristic->getValue().c_str();
    if (rxValue.length() > 0) {
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, rxValue);
      if (err == DeserializationError::Ok) {
        String newSsid = String(doc["ssid"] | "");
        String newPass = String(doc["pass"] | "");
        newSsid.trim();
        newPass.trim();

        if (newSsid.length() > 0) {
          currentSsid = newSsid;
          currentPass = newPass;

          Serial.println("[BLE PROVISION] Received SSID: '" + currentSsid + "' - saving to NVS & SD...");
          lcdMsg("SAVING WIFI...", currentSsid.substring(0, 16));
          beep(200, 1);

          saveWifiToNVS(currentSsid, currentPass);
          saveWifiToSD(currentSsid, currentPass);

          // Acknowledge receipt to Web Bluetooth client
          if (pBleCharacteristic && bleClientConnected) {
            String resp = "{\"event\":\"SAVED\",\"ssid\":\"" + currentSsid + "\"}";
            pBleCharacteristic->setValue(resp.c_str());
            pBleCharacteristic->notify();
          }

          newWifiCredentialsReceived = true;
        }
      }
    }
  }
};

void sendDeviceHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/devices?esp32_identifier=eq." + String(GATE_ID);
  http.begin(url);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  http.addHeader("Content-Type", "application/json");

  String payload = "{\"status\":\"ONLINE\",\"last_online\":\"now()\"}";
  int code = http.PATCH(payload);
  if (code < 200 || code >= 300) {
    http.end();
    String upsertUrl = String(SUPABASE_URL) + "/rest/v1/devices";
    http.begin(upsertUrl);
    http.addHeader("apikey", SUPABASE_ANON);
    http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Prefer", "resolution=merge-duplicates");
    String fullPayload = "{\"esp32_identifier\":\"" + String(GATE_ID) + 
                         "\",\"device_name\":\"CHARRMPASS Long-Range UHF Unit" + 
                         "\",\"gate_type\":\"ENTRY_EXIT" + 
                         "\",\"device_category\":\"" + String(GATE_CATEGORY) + 
                         "\",\"rfid_range\":\"" + String(RFID_RANGE_MODE) + 
                         "\",\"device_location\":\"Main Gate Barrier\"" + 
                         ",\"status\":\"ONLINE\",\"last_online\":\"now()\"}";
    http.POST(fullPayload);
  }
  http.end();
}

void startBleServer() {
  if (bleServerRunning) return;

  Serial.println("[BLE] Initializing Bluetooth Provisioning Server...");
  lcdMsg("BLE SETUP MODE", "PAIR ON WEB/APP");

  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setMTU(517);
  pBleServer = BLEDevice::createServer();
  pBleServer->setCallbacks(new BleServerCallbacks());

  BLEService* pService = pBleServer->createService(BLE_SERVICE_UUID);
  pBleCharacteristic = pService->createCharacteristic(
      BLE_CHAR_UUID,
      BLECharacteristic::PROPERTY_READ |
      BLECharacteristic::PROPERTY_WRITE |
      BLECharacteristic::PROPERTY_WRITE_NR |
      BLECharacteristic::PROPERTY_NOTIFY
  );

  pBleCharacteristic->setCallbacks(new BleCharCallbacks());
  pBleCharacteristic->addDescriptor(new BLE2902());
  pService->start();

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(BLE_SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  bleServerRunning = true;
  Serial.println("[BLE] Broadcasting as '" + String(BLE_DEVICE_NAME) + "'. Ready for pairing.");
}

void stopBleServer() {
  if (!bleServerRunning) return;
  Serial.println("[BLE] Wi-Fi connected! Stopping Bluetooth to free RAM...");
  BLEDevice::deinit(true);
  bleServerRunning = false;
  bleClientConnected = false;
}



// =======================
// SD CARD: SAVE Wi-Fi BACKUP
// =======================
void saveWifiToSD(String ssid, String pass) {
  if (!sdCardReady) return;
  if (!SD.exists("/config")) SD.mkdir("/config");
  File f = SD.open(WIFI_CONFIG_FILE, FILE_WRITE);
  if (f) {
    f.println("SSID=" + ssid);
    f.println("PASSWORD=" + pass); // Local SD only — never sent to cloud
    f.close();
    Serial.println("[SD] Wi-Fi backup saved to " + String(WIFI_CONFIG_FILE));
  } else {
    Serial.println("[SD] Could not write Wi-Fi backup to SD");
  }
}

// =======================
// SD CARD: LOAD Wi-Fi BACKUP
// =======================
bool loadWifiFromSD(String &outSsid, String &outPass) {
  if (!sdCardReady || !SD.exists(WIFI_CONFIG_FILE)) return false;
  File f = SD.open(WIFI_CONFIG_FILE, FILE_READ);
  if (!f) return false;
  outSsid = ""; outPass = "";
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.startsWith("SSID=")) {
      outSsid = line.substring(5);
    } else if (line.startsWith("PASSWORD=")) {
      outPass = line.substring(9);
    }
  }
  f.close();
  if (outSsid.length() > 0) {
    Serial.println("[SD] Wi-Fi backup found. SSID: '" + outSsid + "'");
    return true;
  }
  return false;
}

// =======================
// NVS: SAVE Wi-Fi CREDENTIALS (only call after successful connection test)
// =======================
void saveWifiToNVS(String ssid, String pass) {
  preferences.begin("charrm_wifi", false);
  preferences.putString("ssid", ssid);
  preferences.putString("pass", pass);
  preferences.end();
  Serial.println("[NVS] Wi-Fi credentials saved. SSID: '" + ssid + "'");
}

// =======================
// DIAGNOSTIC 2.4GHz WI-FI SCANNER
// =======================
void scanAndPrintNetworks() {
  Serial.println("\n[WIFI SCAN] Scanning for nearby 2.4GHz Wi-Fi networks...");
  int n = WiFi.scanNetworks(false, true);
  if (n <= 0) {
    Serial.println("[WIFI SCAN] No networks found. (Make sure router is broadcasting on 2.4GHz)");
  } else {
    Serial.println("[WIFI SCAN] Discovered " + String(n) + " network(s):");
    for (int i = 0; i < n; ++i) {
      String sec = (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? "OPEN" : "SECURED";
      Serial.println("   [" + String(i + 1) + "] \"" + WiFi.SSID(i) + "\" | RSSI: " + String(WiFi.RSSI(i)) + " dBm | " + sec);
    }
  }
  Serial.println();
}

// =====================================================
// 6. WI-FI CONNECTION CONTROLLER
// =====================================================
bool attemptWifiConnection(String testSsid, String testPass, int timeoutSeconds = 20) {
  if (testSsid.length() == 0) return false;

  Serial.println("\n===========================================");
  Serial.println("[WIFI] Target SSID: '" + testSsid + "'");
  if (testPass.length() > 0) {
    Serial.println("[WIFI] Password:    [" + String(testPass.length()) + " characters]");
  } else {
    Serial.println("[WIFI] Password:    (NONE / OPEN NETWORK)");
  }
  Serial.println("===========================================");
  lcdMsg("CONNECTING WIFI", testSsid.substring(0, 16));

  // Pause BLE advertising while connecting to prevent 2.4GHz radio collisions
  if (bleServerRunning && BLEDevice::getAdvertising()) {
    BLEDevice::stopAdvertising();
    delay(100);
  }

  // Proper WiFi initialization — DO NOT use WiFi.disconnect(true) which powers off radio!
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(150);

  WiFi.setAutoReconnect(true);

  if (testPass.length() > 0) {
    WiFi.begin(testSsid.c_str(), testPass.c_str());
  } else {
    WiFi.begin(testSsid.c_str(), NULL);
  }

  Serial.print("[WIFI] Connecting to '" + testSsid + "'");
  int elapsed = 0;
  while (WiFi.status() != WL_CONNECTED && elapsed < timeoutSeconds * 2) {
    delay(500);
    Serial.print(".");
    elapsed++;

    if (WiFi.status() == WL_CONNECT_FAILED) {
      Serial.println("\n[WIFI ERROR] WL_CONNECT_FAILED (Code 4): Password was rejected by the router!");
      break;
    }
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    WiFi.setSleep(false); // Disable WiFi modem sleep only AFTER successful connection
    Serial.println("\n[OK] WiFi Connected! IP: " + WiFi.localIP().toString() + " | RSSI: " + String(WiFi.RSSI()) + " dBm");
    lcdMsg("WIFI CONNECTED", WiFi.localIP().toString());
    delay(1000);

    // ── SAVE ONLY ON SUCCESS (test-then-save) ──
    saveWifiToNVS(testSsid, testPass);
    saveWifiToSD(testSsid, testPass);
    currentSsid = testSsid;
    currentPass = testPass;

    String notifyMsg = "{\"event\":\"CONNECTED\",\"ssid\":\"" + testSsid + "\",\"ip\":\"" + WiFi.localIP().toString() + "\",\"rssi\":" + String(WiFi.RSSI()) + "}";
    sendBleStatus(notifyMsg);

    sendDeviceHeartbeat();
    stopBleServer();
    return true;
  } else {
    wifiConnected = false;
    int st = WiFi.status();
    Serial.println("\n[WARN] WiFi connection failed (Status: " + String(st) + ")");
    if (st == WL_NO_SSID_AVAIL) {
      Serial.println("       Reason: WL_NO_SSID_AVAIL (1) — SSID '" + testSsid + "' not found! Check spelling and ensure 2.4GHz is enabled.");
    } else if (st == WL_CONNECT_FAILED) {
      Serial.println("       Reason: WL_CONNECT_FAILED (4) — Incorrect password.");
    } else if (st == WL_DISCONNECTED) {
      Serial.println("       Reason: WL_DISCONNECTED (6) — Handshake timeout or radio contention.");
    }
    Serial.println("[WARN] Credentials NOT saved (test-then-save policy).");
    lcdMsg("WIFI FAILED", "Check SSID/Pass");

    // Scan and list nearby 2.4GHz networks for diagnostics
    scanAndPrintNetworks();

    String errMsg = (st == WL_NO_SSID_AVAIL) ? "SSID not found on 2.4GHz" : ((st == WL_CONNECT_FAILED) ? "Incorrect password" : "Connection failed");
    String notifyMsg = "{\"event\":\"FAILED\",\"error\":\"" + errMsg + "\",\"code\":" + String(st) + "}";
    sendBleStatus(notifyMsg);

    // Resume BLE advertising so user can re-provision
    if (bleServerRunning && BLEDevice::getAdvertising()) {
      BLEDevice::startAdvertising();
      Serial.println("[BLE] Advertising resumed for re-provisioning.");
    }
    delay(1000);
    return false;
  }
}

// =====================================================
// 7. DYNAMIC AUTO ENTRY / EXIT STATE MACHINE
// =====================================================
String determineNextDirectionOnline(String uid) {
  String url = String(SUPABASE_URL) + "/rest/v1/transactions?rfid_uid=eq." +
               urlEncode(uid) +
               "&status=eq.AUTHORIZED&order=timestamp.desc&limit=1&select=direction";

  HTTPClient http;
  http.begin(url);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

  int code = http.GET();
  String body = "";
  if (code == 200) body = http.getString();
  http.end();

  if (body.length() > 0 && body != "[]") {
    DynamicJsonDocument doc(512);
    if (deserializeJson(doc, body) == DeserializationError::Ok) {
      JsonArray arr = doc.as<JsonArray>();
      if (arr.size() > 0) {
        String lastDir = String(arr[0]["direction"] | "EXIT");
        if (lastDir == "ENTRY") return "EXIT";
        else return "ENTRY";
      }
    }
  }
  return "ENTRY";
}

bool isTagCurrentlyInsideOffline(String uid) {
  if (!sdCardReady || !SD.exists(INSIDE_LIST_FILE)) return false;
  File f = SD.open(INSIDE_LIST_FILE, FILE_READ);
  if (!f) return false;
  bool inside = false;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line == uid) {
      inside = true;
      break;
    }
  }
  f.close();
  return inside;
}

void updateOfflinePresence(String uid, String newDirection) {
  if (!sdCardReady) return;
  if (newDirection == "ENTRY") {
    File f = SD.open(INSIDE_LIST_FILE, FILE_APPEND);
    if (f) {
      f.println(uid);
      f.close();
    }
  } else {
    if (!SD.exists(INSIDE_LIST_FILE)) return;
    File f = SD.open(INSIDE_LIST_FILE, FILE_READ);
    if (!f) return;
    String updatedContent = "";
    while (f.available()) {
      String line = f.readStringUntil('\n');
      line.trim();
      if (line.length() > 0 && line != uid) {
        updatedContent += line + "\n";
      }
    }
    f.close();
    File fw = SD.open(INSIDE_LIST_FILE, FILE_WRITE);
    if (fw) {
      fw.print(updatedContent);
      fw.close();
    }
  }
}

// =====================================================
// OFFLINE WHITELIST VERIFICATION
// =====================================================
bool checkAuthorizationOffline(String uid) {
  card_found = false;
  card_authorized = false;
  card_name = "";
  card_plate = "";
  card_role = "";

  if (!sdCardReady || !SD.exists(WHITELIST_FILE)) {
    // If no SD whitelist cache exists yet, fallback: allow valid tag numbers
    return (uid.length() > 3);
  }

  File f = SD.open(WHITELIST_FILE, FILE_READ);
  if (!f) return (uid.length() > 3);

  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.startsWith(uid)) {
      card_found = true;
      card_authorized = true;

      int firstComma = line.indexOf(',');
      int secondComma = line.indexOf(',', firstComma + 1);
      int thirdComma = line.indexOf(',', secondComma + 1);

      if (firstComma > 0 && secondComma > 0) {
        card_name = line.substring(firstComma + 1, secondComma);
        if (thirdComma > 0) {
          card_plate = line.substring(secondComma + 1, thirdComma);
          card_role = line.substring(thirdComma + 1);
        } else {
          card_plate = line.substring(secondComma + 1);
        }
      }
      break;
    }
  }
  f.close();
  return card_authorized;
}

// =====================================================
// 8. VERIFICATION & TRANSACTION POSTING
// =====================================================
bool checkAuthorizationOnline(String uid) {
  card_found = false;
  card_authorized = false;
  card_name = "";
  card_plate = "";
  card_role = "";
  card_userType = "VEHICLE";
  card_rfidType = "LONG_RANGE";
  card_vehicleId = "";
  card_userId = "";

  // 1. Check Special Tags (Visitor / Emergency)
  String specUrl = String(SUPABASE_URL) + "/rest/v1/special_tags?rfid_uid=eq." +
                   urlEncode(uid) + "&select=type,label,description,rfid_type,user_type";
  HTTPClient httpSpec;
  httpSpec.begin(specUrl);
  httpSpec.addHeader("apikey", SUPABASE_ANON);
  httpSpec.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  int specCode = httpSpec.GET();
  if (specCode == 200) {
    String specBody = httpSpec.getString();
    DynamicJsonDocument specDoc(512);
    if (deserializeJson(specDoc, specBody) == DeserializationError::Ok) {
      JsonArray specArr = specDoc.as<JsonArray>();
      if (specArr.size() > 0) {
        card_found = true;
        card_authorized = true;
        String specType = String(specArr[0]["type"] | "VISITOR");
        card_role = specType;
        card_userType = String(specArr[0]["user_type"] | "VEHICLE");
        card_rfidType = String(specArr[0]["rfid_type"] | "LONG_RANGE");

        if (specType == "EMERGENCY") {
          card_name = String(specArr[0]["label"] | "Emergency Response");
          card_plate = "EMERGENCY";
        } else {
          card_name = String(specArr[0]["label"] | "Visitor Pass");
          card_plate = "VISITOR PASS";
        }
        httpSpec.end();
        return true;
      }
    }
  }
  httpSpec.end();

  // 2. Query Registered Users & Vehicles
  String url = String(SUPABASE_URL) + "/rest/v1/rfid_cards?rfid_uid=eq." +
               urlEncode(uid) +
               "&select=authorization_status,vehicle_id,user_id,rfid_type,user_type,"
               "vehicles(plate_number,vehicle_type,vehicle_model),"
               "users(full_name,role,default_transit_mode)";

  HTTPClient http;
  http.begin(url);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);

  int code = http.GET();
  String body = "";
  if (code == 200) body = http.getString();
  http.end();

  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, body) != DeserializationError::Ok) return false;

  JsonArray arr = doc.as<JsonArray>();
  if (arr.size() == 0) return false;

  JsonObject card = arr[0];
  card_found = true;
  card_authorized = (String(card["authorization_status"].as<const char*>()) == "AUTHORIZED");
  card_vehicleId  = String(card["vehicle_id"] | "");
  card_userId     = String(card["user_id"] | "");
  card_userType   = String(card["user_type"] | "VEHICLE");
  card_rfidType   = String(card["rfid_type"] | "LONG_RANGE");

  if (!card["vehicles"].isNull()) {
    card_plate = String(card["vehicles"]["plate_number"] | "");
    String vType = String(card["vehicles"]["vehicle_type"] | "");
    if (vType == "None" || card_plate == "PEDESTRIAN") {
      card_userType = "PEDESTRIAN";
      card_rfidType = "CLOSE_RANGE";
    }
  }

  if (!card["users"].isNull()) {
    card_name = String(card["users"]["full_name"] | "");
    card_role = String(card["users"]["role"] | "");
    String defMode = String(card["users"]["default_transit_mode"] | "");
    if (defMode == "PEDESTRIAN") {
      card_userType = "PEDESTRIAN";
      card_rfidType = "CLOSE_RANGE";
    }
  }

  return card_authorized;
}

void syncWhitelistToRam() {
  if (!wifiConnected) return;
  Serial.println("\n[RAM CACHE] Syncing registered cards from Supabase...");
  
  // 1. Fetch special tags (Visitors / Emergency)
  String specUrl = String(SUPABASE_URL) + "/rest/v1/special_tags?select=rfid_uid,type,label,rfid_type,user_type";
  HTTPClient httpSpec;
  httpSpec.begin(specUrl);
  httpSpec.addHeader("apikey", SUPABASE_ANON);
  httpSpec.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  int sCode = httpSpec.GET();
  if (sCode == 200) {
    DynamicJsonDocument sDoc(2048);
    if (deserializeJson(sDoc, httpSpec.getString()) == DeserializationError::Ok) {
      JsonArray arr = sDoc.as<JsonArray>();
      for (JsonObject item : arr) {
        String uid = String(item["rfid_uid"] | "");
        String sType = String(item["type"] | "VISITOR");
        String lbl = String(item["label"] | (sType == "EMERGENCY" ? "Emergency Responder" : "Visitor Pass"));
        String uType = String(item["user_type"] | "VEHICLE");
        if (uid.length() > 0) {
          addCardToRam(uid, lbl, (sType == "EMERGENCY" ? "EMERGENCY" : "VISITOR PASS"), sType, uType, "", "", true);
        }
      }
    }
  }
  httpSpec.end();

  // 2. Fetch registered vehicle and user cards
  String url = String(SUPABASE_URL) + "/rest/v1/rfid_cards?select=rfid_uid,authorization_status,vehicle_id,user_id,rfid_type,user_type,vehicles(plate_number,vehicle_type,vehicle_model),users(full_name,role)&limit=100";
  HTTPClient http;
  http.begin(url);
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  int code = http.GET();
  if (code == 200) {
    DynamicJsonDocument doc(8192);
    if (deserializeJson(doc, http.getString()) == DeserializationError::Ok) {
      JsonArray arr = doc.as<JsonArray>();
      for (JsonObject item : arr) {
        String uid = String(item["rfid_uid"] | "");
        String status = String(item["authorization_status"] | "PENDING");
        bool auth = (status == "AUTHORIZED");
        String vId = String(item["vehicle_id"] | "");
        String uId = String(item["user_id"] | "");
        String uType = String(item["user_type"] | "VEHICLE");
        String plate = "NO-PLATE";
        String name = "Cardholder";
        String role = "User";

        if (!item["vehicles"].isNull()) {
          plate = String(item["vehicles"]["plate_number"] | "NO-PLATE");
        }
        if (!item["users"].isNull()) {
          name = String(item["users"]["full_name"] | "Registered User");
          role = String(item["users"]["role"] | "Student");
        }

        if (uid.length() > 0) {
          addCardToRam(uid, name, plate, role, uType, vId, uId, auth);
        }
      }
      Serial.printf("[RAM CACHE] Successfully loaded %d registered card(s) into high-speed memory!\n", ramCardCount);
    }
  }
  http.end();
}

void processCloudQueue() {
  if (txQueueCount == 0 || !wifiConnected) return;
  // If Wiegand is currently receiving pulses, NEVER interrupt the reader!
  if (wiegandBitCount > 0) return;

  QueuedTransaction item = txQueue[txQueueHead];
  txQueueHead = (txQueueHead + 1) % MAX_TX_QUEUE;
  txQueueCount--;

  insertTransactionOnline(item.uid, item.direction, item.status, item.remarks, item.vehicleId, item.userId, item.userType);
}

void insertTransactionOnline(String uid, String direction, String status, String remarks, String vId, String uId, String uType) {
  String url = String(SUPABASE_URL) + "/rest/v1/transactions";

  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  http.addHeader("Prefer", "return=minimal");

  DynamicJsonDocument doc(512);
  doc["rfid_uid"]   = uid;
  doc["direction"]  = direction;
  doc["gate"]       = GATE_ID;
  doc["status"]     = status;
  doc["remarks"]    = remarks;
  doc["user_type"]  = (uType.length() > 0 ? uType : card_userType);
  doc["rfid_type"]  = "LONG_RANGE";

  String targetVId = (vId.length() > 0 ? vId : card_vehicleId);
  String targetUId = (uId.length() > 0 ? uId : card_userId);

  if (targetVId.length() > 0 && targetVId != "null")
    doc["vehicle_id"] = targetVId;
  if (targetUId.length() > 0 && targetUId != "null")
    doc["user_id"] = targetUId;

  String body;
  serializeJson(doc, body);
  http.POST(body);
  http.end();
}

// =====================================================
// 9. HIGH-SPEED SCAN EVENT DISPATCHER
// Fast in-memory RAM match (< 0.1ms), instant LCD & Serial
// =====================================================
void handleScannedTag(String uid, String altUid = "") {
  uid.trim();
  uid.toUpperCase();
  altUid.trim();
  altUid.toUpperCase();

  unsigned long scanStartUs = micros();

  // Multi-Tag Anti-Spam Check: Ignore if this exact tag was scanned within TAG_COOLDOWN_MS
  if (isTagInCooldown(uid) || (altUid.length() > 0 && isTagInCooldown(altUid))) {
    return; // Silently skip duplicate pulses for this tag while it remains in the 6m zone
  }

  // Mark this tag in the cooldown history table immediately
  markTagInCooldown(uid);
  if (altUid.length() > 0) markTagInCooldown(altUid);

  // 1. FAST IN-MEMORY RAM LOOKUP (0.05 ms)
  int cardIdx = findCardInRam(uid);
  if (cardIdx == -1 && altUid.length() > 0) cardIdx = findCardInRam(altUid);

  bool authorized = false;
  String finalUid = uid;
  String name = "";
  String plate = "";
  String role = "";
  String uType = "VEHICLE";
  String vId = "";
  String uId = "";
  String direction = "ENTRY";

  if (cardIdx != -1) {
    // RAM CACHE HIT! Instant authorization
    authorized = ramCards[cardIdx].authorized;
    finalUid = ramCards[cardIdx].uid;
    name = ramCards[cardIdx].name;
    plate = ramCards[cardIdx].plate;
    role = ramCards[cardIdx].role;
    uType = ramCards[cardIdx].userType;
    vId = ramCards[cardIdx].vehicleId;
    uId = ramCards[cardIdx].userId;

    // Fast direction toggle: ENTRY -> EXIT -> ENTRY
    direction = (ramCards[cardIdx].lastDirection == "ENTRY") ? "EXIT" : "ENTRY";
    ramCards[cardIdx].lastDirection = direction;

  } else {
    // RAM CACHE MISS: Query Online (or Offline SD) and cache result
    if (wifiConnected) {
      authorized = checkAuthorizationOnline(uid);
      if (!authorized && altUid.length() > 0) {
        authorized = checkAuthorizationOnline(altUid);
        if (authorized) finalUid = altUid;
      }
      direction = determineNextDirectionOnline(finalUid);
    } else {
      authorized = checkAuthorizationOffline(uid);
      if (!authorized && altUid.length() > 0) {
        authorized = checkAuthorizationOffline(altUid);
        if (authorized) finalUid = altUid;
      }
      direction = isTagCurrentlyInsideOffline(finalUid) ? "EXIT" : "ENTRY";
      if (!authorized) authorized = (uid.length() > 3);
    }

    name = card_name;
    plate = card_plate;
    role = card_role;
    uType = card_userType;
    vId = card_vehicleId;
    uId = card_userId;

    // Cache in RAM for instantaneous subsequent reads
    addCardToRam(finalUid, name, plate, role, uType, vId, uId, authorized, direction);
  }

  unsigned long processTimeUs = micros() - scanStartUs;

  // 2. INSTANT LCD DISPLAY (1.2 ms, NO FLICKER)
  if (authorized) {
    char l1[17], l2[17];
    snprintf(l1, sizeof(l1), "[%-5s] %-8s", direction.c_str(), plate.c_str());
    snprintf(l2, sizeof(l2), "%-16.16s", name.c_str());
    lcdShowFast(l1, l2);
  } else {
    char l1[17], l2[17];
    snprintf(l1, sizeof(l1), "[DENIED] %-8s", uid.substring(0, 8).c_str());
    snprintf(l2, sizeof(l2), "UNREGISTERED TAG");
    lcdShowFast(l1, l2);
  }

  // 3. INSTANT SERIAL OUTPUT (< 1 ms)
  Serial.println("\n⚡⚡⚡ [ULTRA-FAST MULTI-SCAN DETECTED] ⚡⚡⚡");
  Serial.printf("  Card ID (Dec): %s%s\n", uid.c_str(), altUid.length() > 0 ? (" | Hex: " + altUid).c_str() : "");
  if (authorized) {
    Serial.printf("  Stakeholder:   %s (%s)\n", name.c_str(), role.c_str());
    Serial.printf("  Vehicle:       %s [%s]\n", plate.c_str(), uType.c_str());
    Serial.printf("  Action:        [%s] Recorded\n", direction.c_str());
    Serial.printf("  Status:        AUTHORIZED (Matched in %.2f ms)\n", processTimeUs / 1000.0);
  } else {
    Serial.printf("  Status:        UNREGISTERED / DENIED (Checked in %.2f ms)\n", processTimeUs / 1000.0);
  }
  Serial.println("────────────────────────────────────────────────");

  // 4. NON-BLOCKING AUDIO/VISUAL CONFIRMATION
  if (authorized) {
    digitalWrite(GREEN_LED, HIGH);
    digitalWrite(RED_LED, LOW);
    beep(40, 1); // Crisp, fast 40ms confirmation click
  } else {
    digitalWrite(RED_LED, HIGH);
    digitalWrite(GREEN_LED, LOW);
    beep(120, 1);
  }

  // 5. ENQUEUE FOR ASYNC CLOUD SYNC (< 1 us)
  if (wifiConnected) {
    String remarks = authorized ? ("UHF Drive-Through (" + uType + ")") : "Unregistered UHF Tag";
    enqueueTransaction(finalUid, direction, authorized ? "AUTHORIZED" : "DENIED", remarks, vId, uId, uType);
  } else {
    updateOfflinePresence(finalUid, direction);
  }

  digitalWrite(GREEN_LED, LOW);
}

// =====================================================
// 10. WIEGAND PULSE DECODER (Boland UHF RFID Reader)
// =====================================================
bool checkWiegandReader(String &outUid, String &outAltUid) {
  outUid = "";
  outAltUid = "";
  if (wiegandBitCount == 0) return false;

  // Wait until pulse transmission has completed (idle for > 12ms = 12,000us)
  if (micros() - wiegandLastPulseUs < 12000) return false;

  noInterrupts();
  uint64_t raw = wiegandRawBits;
  int bits = wiegandBitCount;
  wiegandRawBits = 0;
  wiegandBitCount = 0;
  interrupts();

  if (bits < 4) {
    Serial.printf("[WIEGAND NOISE] Ignored %d spurious pulse(s)\n", bits);
    return false;
  }

  Serial.println("\n========================================");
  Serial.printf("[WIEGAND PULSE DETECTED] Total bits: %d | Raw Hex: 0x%llX\n", bits, (unsigned long long)raw);

  uint32_t cardNumber = 0;
  uint32_t facilityCode = 0;
  char hexFormatted[32];
  char decPadded[16];
  hexFormatted[0] = '\0';
  decPadded[0] = '\0';

  if (bits == 26) {
    // WG26 format: 1 even parity + 8 facility + 16 card number + 1 odd parity
    facilityCode = (raw >> 17) & 0xFF;
    cardNumber   = (raw >> 1) & 0xFFFF;
    snprintf(hexFormatted, sizeof(hexFormatted), "%02X %02X %02X",
            (uint8_t)(facilityCode),
            (uint8_t)(cardNumber >> 8),
            (uint8_t)(cardNumber & 0xFF));
    snprintf(decPadded, sizeof(decPadded), "%010lu", (unsigned long)cardNumber);
    Serial.println("  Standard:      WG26 (26-bit)");
    Serial.println("  Facility:      " + String(facilityCode));
    Serial.println("  Card ID (Dec): " + String(cardNumber) + " (Padded: " + String(decPadded) + ")");
    Serial.println("  Hex UID:       " + String(hexFormatted));

    outUid = String(cardNumber);
    outAltUid = String(decPadded);

  } else if (bits == 34) {
    // WG34 format: 1 even parity + 32 card number + 1 odd parity
    cardNumber = (raw >> 1) & 0xFFFFFFFF;
    snprintf(hexFormatted, sizeof(hexFormatted), "%02X %02X %02X %02X",
            (uint8_t)(cardNumber >> 24),
            (uint8_t)(cardNumber >> 16),
            (uint8_t)(cardNumber >> 8),
            (uint8_t)(cardNumber & 0xFF));
    snprintf(decPadded, sizeof(decPadded), "%010lu", (unsigned long)cardNumber);
    Serial.println("  Standard:      WG34 (34-bit)");
    Serial.println("  Card ID (Dec): " + String(cardNumber) + " (10-Digit: " + String(decPadded) + ")");
    Serial.println("  Hex UID:       " + String(hexFormatted));

    // Support both 10-digit zero-padded (e.g. 0419670354) and regular decimal
    outUid = String(decPadded);
    outAltUid = String(cardNumber);

  } else {
    // Custom / other bit counts (e.g. 28, 32, 36)
    cardNumber = (uint32_t)(raw & 0xFFFFFFFF);
    snprintf(hexFormatted, sizeof(hexFormatted), "%02X %02X %02X %02X",
            (uint8_t)(cardNumber >> 24),
            (uint8_t)(cardNumber >> 16),
            (uint8_t)(cardNumber >> 8),
            (uint8_t)(cardNumber & 0xFF));
    snprintf(decPadded, sizeof(decPadded), "%010lu", (unsigned long)cardNumber);
    Serial.printf("  Standard:      %d-bit Wiegand\n", bits);
    Serial.println("  Card ID (Dec): " + String(cardNumber) + " (Padded: " + String(decPadded) + ")");
    Serial.println("  Hex UID:       " + String(hexFormatted));

    outUid = String(decPadded);
    outAltUid = String(cardNumber);
  }

  Serial.println("========================================");
  return true;
}

// =====================================================
// 11. SETUP & INITIALIZATION
// =====================================================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n================================================");
  Serial.println("CHARRMPASS — ESP32 Single UHF Gate + BLE Setup");
  Serial.println("================================================");

  // Peripherals
  pinMode(RED_LED, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RELAY_PIN, OUTPUT);

  digitalWrite(RED_LED, HIGH);
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RELAY_PIN, HIGH); // Relay OFF

  // LCD Init
  Wire.begin(21, 22);
  lcd.begin(16, 2);
  lcdMsg("CHARRMPASS v4.5", "BOOTING GATE...");
  delay(1000);

  // Wiegand UHF Reader Interrupt Init on GPIO 32 (D0 primary), GPIO 35 (D0 alt), and GPIO 33 (D1)
  #if ENABLE_WIEGAND
    pinMode(WIEGAND_D0_PIN, INPUT_PULLUP);
    pinMode(WIEGAND_D0_PIN_ALT, INPUT);
    pinMode(WIEGAND_D1_PIN, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(WIEGAND_D0_PIN), isrWiegandD0, FALLING);
    attachInterrupt(digitalPinToInterrupt(WIEGAND_D0_PIN_ALT), isrWiegandD0, FALLING);
    attachInterrupt(digitalPinToInterrupt(WIEGAND_D1_PIN), isrWiegandD1, FALLING);
    Serial.println("[WIEGAND] Boland UHF Reader initialized on GPIO 32/35 (D0) and GPIO 33 (D1).");
  #endif

  // SPI Backup Reader Init
  #if ENABLE_SPI_MFRC522
    SPI.begin(18, 19, 23, 5);
    rfid.PCD_Init();
    Serial.println("[RFID] SPI MFRC522 Backup Reader initialized.");
  #endif

  // 3. Load Saved Wi-Fi Credentials
  // Priority 1: NVS Flash
  preferences.begin("charrm_wifi", true);
  currentSsid = preferences.getString("ssid", "");
  currentPass = preferences.getString("pass", "");
  preferences.end();

  // Priority 2: SD Card Backup (/config/wifi.cfg) if NVS is empty
  if (currentSsid.length() == 0) {
    if (loadWifiFromSD(currentSsid, currentPass)) {
      Serial.println("[BOOT] Loaded Wi-Fi credentials from SD backup: '" + currentSsid + "'");
    }
  }

  if (currentSsid.length() > 0) {
    // 4a. Credentials found (NVS or SD) — attempt WiFi FIRST (BLE paused to avoid radio contention)
    Serial.println("[BOOT] Wi-Fi credentials found: '" + currentSsid + "'. Attempting connection...");
    bool ok = attemptWifiConnection(currentSsid, currentPass, 15);
    if (!ok) {
      Serial.println("[BOOT] Wi-Fi connection failed. Starting BLE for re-provisioning.");
      startBleServer();
    } else {
      syncWhitelistToRam();
    }
  } else {
    // 4b. No credentials found anywhere — open BLE for initial provisioning
    Serial.println("[BOOT] No saved Wi-Fi credentials found in NVS or SD. Starting BLE setup mode.");
    lcdMsg("[NO WIFI SAVED]", "BLE SETUP MODE");
    startBleServer();
  }

  showReady();
}

// =====================================================
// 12. MAIN LOOP (HIGH-SPEED MULTI-TAG EVENT LOOP)
// =====================================================
void loop() {
  // If new Wi-Fi credentials were sent from Web Bluetooth, connect now!
  if (newWifiCredentialsReceived) {
    newWifiCredentialsReceived = false;
    Serial.println("\n[PROVISION] Credentials saved to NVS Flash and SD Card!");
    Serial.println("[PROVISION] Restarting ESP32 to connect cleanly with dedicated radio & RAM...");
    lcdMsg("WIFI SAVED!", "RESTARTING...");
    beep(200, 2);
    delay(800);
    ESP.restart();
  }

  // Periodic Wi-Fi watchdog & Heartbeat
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiConnected) {
      wifiConnected = true;
      Serial.println("[WIFI] Reconnected to network!");
      sendDeviceHeartbeat();
      syncWhitelistToRam();
      stopBleServer();
      showReady();
    }
    if (millis() - lastHeartbeat >= HEARTBEAT_INTERVAL) {
      lastHeartbeat = millis();
      sendDeviceHeartbeat();
    }
  } else {
    if (wifiConnected) {
      wifiConnected = false;
      Serial.println("[WIFI] Lost Wi-Fi connection. BLE active for re-provisioning...");
      startBleServer();
      showReady();
    }
  }

  // 1. Process asynchronous background cloud transactions whenever Wiegand is idle
  processCloudQueue();

  // 2. Periodic RAM Whitelist Sync from Supabase (every 5 minutes)
  if (wifiConnected && (millis() - lastWhitelistSync >= WHITELIST_SYNC_INTERVAL)) {
    lastWhitelistSync = millis();
    syncWhitelistToRam();
  }

  // 3. Reset LCD display to ready screen after 3 seconds of idle time
  if (lastTagDisplayMillis > 0 && (millis() - lastTagDisplayMillis >= 3000)) {
    lastTagDisplayMillis = 0;
    showReady();
  }

  // Serial input: RESET: to clear credentials, or manual UID
  if (Serial.available() > 0) {
    String inputStr = Serial.readStringUntil('\n');
    inputStr.trim();
    if (inputStr.length() > 0) {

      // ── WIFI:<SSID>,<PASS>  → Test credentials and save ONLY on success ──
      if (inputStr.startsWith("WIFI:") || inputStr.startsWith("wifi:")) {
        String payload = inputStr.substring(5);
        int comma = payload.indexOf(',');
        if (comma != -1) {
          currentSsid = payload.substring(0, comma);
          currentPass = payload.substring(comma + 1);
        } else {
          currentSsid = payload;
          currentPass = "";
        }
        currentSsid.trim();
        currentPass.trim();

        Serial.println("\n[SERIAL PROVISION] Testing credentials for SSID: '" + currentSsid + "'...");
        lcdMsg("TESTING WIFI...", currentSsid.substring(0, 16));
        beep(200, 1);
        bool ok = attemptWifiConnection(currentSsid, currentPass, 15);
        if (ok) syncWhitelistToRam();
        showReady();
        return;
      }

      // ── RESET: → Wipe NVS credentials and SD backup, then re-enter BLE provisioning mode ──
      if (inputStr.equalsIgnoreCase("RESET:") || inputStr.equalsIgnoreCase("RESET")) {
        preferences.begin("charrm_wifi", false);
        preferences.remove("ssid");
        preferences.remove("pass");
        preferences.end();
        if (sdCardReady && SD.exists(WIFI_CONFIG_FILE)) {
          SD.remove(WIFI_CONFIG_FILE);
          Serial.println("[RESET] SD Wi-Fi backup removed.");
        }
        currentSsid = "";
        currentPass = "";
        Serial.println("[RESET] Wi-Fi credentials cleared from NVS & SD. Restarting BLE provisioning...");
        lcdMsg("WIFI RESET", "BLE SETUP MODE");
        beep(400, 1);
        delay(500);
        WiFi.disconnect(true);
        wifiConnected = false;
        startBleServer();
        showReady();
        return;
      }

      // ── Manual tag UID for testing ──
      String testUid = inputStr;
      testUid.toUpperCase();
      Serial.println("[MANUAL] Simulating UHF tag: " + testUid);
      handleScannedTag(testUid);
    }
  }

  // 4. Poll Boland Long-Range UHF Wiegand Reader (High Priority)
  #if ENABLE_WIEGAND
    String wiegandUid = "";
    String wiegandAlt = "";
    if (checkWiegandReader(wiegandUid, wiegandAlt)) {
      handleScannedTag(wiegandUid, wiegandAlt);
    }
  #endif

  // 5. Poll Backup SPI Reader
  #if ENABLE_SPI_MFRC522
    if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
      String uid = "";
      for (byte i = 0; i < rfid.uid.size; i++) {
        char h[4];
        sprintf(h, "%02X", rfid.uid.uidByte[i]);
        uid += h;
        if (i < rfid.uid.size - 1) uid += " ";
      }
      rfid.PICC_HaltA();
      rfid.PCD_StopCrypto1();

      handleScannedTag(uid);
    }
  #endif

  // 6. Live Wiegand Hardware Diagnostics (Printed every 6 seconds)
  static unsigned long lastWiegandDiag = 0;
  if (millis() - lastWiegandDiag >= 6000) {
    lastWiegandDiag = millis();
    int d0_32 = digitalRead(WIEGAND_D0_PIN);
    int d0_35 = digitalRead(WIEGAND_D0_PIN_ALT);
    int d1_33 = digitalRead(WIEGAND_D1_PIN);
    Serial.printf("[WIEGAND HARDWARE MONITOR] Wire Levels: G32(D0)=%s | G35(D0_alt)=%s | G33(D1)=%s | Total Pulses Detected=%u\n",
                  d0_32 ? "HIGH" : "LOW (CHECK PULLUP)",
                  d0_35 ? "HIGH" : "LOW (CHECK PULLUP)",
                  d1_33 ? "HIGH" : "LOW (CHECK PULLUP)",
                  wiegandTotalPulses);
  }

  delayMicroseconds(200); // High-frequency polling (zero lag)
}
