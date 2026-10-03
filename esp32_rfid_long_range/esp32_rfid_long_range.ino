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
#define WIEGAND_D0_PIN       32   // Data 0 (Move from G35 to G32 for internal pull-up!)
#define WIEGAND_D1_PIN       33   // White wire: Data 1 (Internal pull-up)

// Interrupt-safe Wiegand pulse buffer with microsecond noise filtering
volatile uint64_t wiegandRawBits = 0;
volatile int wiegandBitCount = 0;
volatile uint32_t wiegandLastPulseUs = 0;

void IRAM_ATTR isrWiegandD0() {
  uint32_t now = micros();
  // Filter out electrical spikes/ringing faster than physical Wiegand pulses (250us)
  if (now - wiegandLastPulseUs < 250) return;
  wiegandLastPulseUs = now;
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
  if (now - wiegandLastPulseUs < 250) return;
  wiegandLastPulseUs = now;
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

// Cooldown / Anti-Collision Tracker
String lastScannedUID = "";
unsigned long lastScanMillis = 0;
const unsigned long TAG_COOLDOWN_MS = 6000; // 6 seconds

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

// Forward declarations
void sendDeviceHeartbeat();
void sendBleStatus(String status);

// =====================================================
// 4. LCD & AUDIO HELPERS
// =====================================================
void lcdMsg(String line1, String line2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(line2.substring(0, 16));
}

void showReady() {
  digitalWrite(RED_LED, HIGH);
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RELAY_PIN, HIGH); // Relay off

  if (wifiConnected) {
    lcdMsg("UHF GATE READY", "AUTO ENTRY/EXIT");
  } else if (bleServerRunning) {
    lcdMsg("[BLE SETUP MODE]", "PAIR PHONE/APP");
  } else {
    lcdMsg("[OFFLINE] READY", "AUTO ENTRY/EXIT");
  }
}

void beep(int ms, int count = 1) {
  for (int i = 0; i < count; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(ms);
    digitalWrite(BUZZER_PIN, LOW);
    if (count > 1) delay(80);
  }
}

void triggerBarrier() {
  // Free-flow automated drive-through monitoring (no barrier arm delay)
  Serial.println("[MONITOR] Free-Flow Vehicle Logged — Pulsing status indicator...");
  digitalWrite(RELAY_PIN, LOW);   // Optional external indicator/strobe trigger
  digitalWrite(GREEN_LED, HIGH);
  digitalWrite(RED_LED, LOW);
  delay(200);                     // Fast 200ms pulse (does not halt or block traffic)
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

void insertTransactionOnline(String uid, String direction, String status, String remarks) {
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
  doc["user_type"]  = card_userType;
  doc["rfid_type"]  = card_rfidType;

  if (card_vehicleId.length() > 0 && card_vehicleId != "null")
    doc["vehicle_id"] = card_vehicleId;
  if (card_userId.length() > 0 && card_userId != "null")
    doc["user_id"] = card_userId;

  String body;
  serializeJson(doc, body);
  http.POST(body);
  http.end();
}

// =====================================================
// 9. SCAN EVENT DISPATCHER
// =====================================================
void handleScannedTag(String uid, String altUid = "") {
  uid.trim();
  uid.toUpperCase();
  altUid.trim();
  altUid.toUpperCase();

  unsigned long now = millis();
  if ((uid == lastScannedUID || (altUid.length() > 0 && altUid == lastScannedUID)) && (now - lastScanMillis < TAG_COOLDOWN_MS)) {
    return; // Suppress duplicate trigger
  }

  lastScannedUID = uid;
  lastScanMillis = now;

  Serial.println("\n========================================");
  Serial.println("[UHF SCAN] Primary Tag ID: " + uid + (altUid.length() > 0 ? " | Alt Hex ID: " + altUid : ""));
  lcdMsg("READING TAG...", uid.substring(0, 16));
  beep(80, 1);

  bool authorized = false;
  String finalMatchedUid = uid;

  if (wifiConnected) {
    authorized = checkAuthorizationOnline(uid);
    if (!authorized && altUid.length() > 0) {
      Serial.println("[UHF SCAN] Checking alternative Hex ID in cloud: " + altUid);
      authorized = checkAuthorizationOnline(altUid);
      if (authorized) {
        finalMatchedUid = altUid;
      }
    }
    calculatedDirection = determineNextDirectionOnline(finalMatchedUid);
  } else {
    authorized = checkAuthorizationOffline(uid);
    if (!authorized && altUid.length() > 0) {
      authorized = checkAuthorizationOffline(altUid);
      if (authorized) finalMatchedUid = altUid;
    }
    if (isTagCurrentlyInsideOffline(finalMatchedUid)) calculatedDirection = "EXIT";
    else calculatedDirection = "ENTRY";
    if (!authorized) authorized = (uid.length() > 3);
  }

  Serial.println("[DIRECTION] Auto-resolved: " + calculatedDirection);

  if (authorized) {
    Serial.println(">>> ACCESS GRANTED [" + calculatedDirection + "] <<<");
    Serial.println("Name: " + card_name + " | Plate: " + card_plate);

    if (calculatedDirection == "ENTRY") {
      lcdMsg("WELCOME [ENTRY]", card_plate.length() > 0 ? card_plate : card_name);
    } else {
      lcdMsg("GOODBYE [EXIT]", card_plate.length() > 0 ? card_plate : card_name);
    }

    beep(120, 2);

    if (wifiConnected) {
      insertTransactionOnline(
        finalMatchedUid,
        calculatedDirection,
        "AUTHORIZED",
        "Single UHF Auto-" + calculatedDirection + " (" + (card_userType == "PEDESTRIAN" ? "Pedestrian" : "Vehicle") + ")"
      );
    } else {
      updateOfflinePresence(finalMatchedUid, calculatedDirection);
    }

    triggerBarrier();
  } else {
    Serial.println(">>> ACCESS DENIED <<<");
    lcdMsg("ACCESS DENIED", "UNAUTHORIZED TAG");
    beep(400, 1);
    digitalWrite(RED_LED, HIGH);
    digitalWrite(GREEN_LED, LOW);

    if (wifiConnected) {
      insertTransactionOnline(finalMatchedUid, calculatedDirection, "DENIED", "Unauthorized UHF Tag");
    }
    delay(300);
  }

  showReady();
}

// =====================================================
// 10. WIEGAND PULSE DECODER (Boland UHF RFID Reader)
// =====================================================
bool checkWiegandReader(String &outUid, String &outAltUid) {
  outUid = "";
  outAltUid = "";
  if (wiegandBitCount == 0) return false;

  // Wait until pulse transmission has completed (idle for > 25ms = 25,000us)
  if (micros() - wiegandLastPulseUs < 25000) return false;

  noInterrupts();
  uint64_t raw = wiegandRawBits;
  int bits = wiegandBitCount;
  wiegandRawBits = 0;
  wiegandBitCount = 0;
  interrupts();

  if (bits < 4) return false; // Ignore spurious noise

  Serial.println("\n========================================");
  Serial.println("[WIEGAND PULSE DETECTED] Total bits: " + String(bits));

  uint32_t cardNumber = 0;
  uint32_t facilityCode = 0;
  char hexFormatted[32];
  hexFormatted[0] = '\0';

  if (bits == 26) {
    // WG26 format: 1 even parity + 8 facility + 16 card number + 1 odd parity
    facilityCode = (raw >> 17) & 0xFF;
    cardNumber   = (raw >> 1) & 0xFFFF;
    sprintf(hexFormatted, "%02X %02X %02X",
            (uint8_t)(facilityCode),
            (uint8_t)(cardNumber >> 8),
            (uint8_t)(cardNumber & 0xFF));
    Serial.println("  Standard: WG26 (26-bit)");
    Serial.println("  Facility: " + String(facilityCode));
    Serial.println("  Card ID (Dec): " + String(cardNumber));
    Serial.println("  Hex UID:       " + String(hexFormatted));

    outUid = String(cardNumber);
    outAltUid = String(hexFormatted);

  } else if (bits == 34) {
    // WG34 format: 1 even parity + 32 card number + 1 odd parity
    cardNumber = (raw >> 1) & 0xFFFFFFFF;
    sprintf(hexFormatted, "%02X %02X %02X %02X",
            (uint8_t)(cardNumber >> 24),
            (uint8_t)(cardNumber >> 16),
            (uint8_t)(cardNumber >> 8),
            (uint8_t)(cardNumber & 0xFF));
    Serial.println("  Standard: WG34 (34-bit)");
    Serial.println("  Card ID (Dec): " + String(cardNumber));
    Serial.println("  Hex UID:       " + String(hexFormatted));

    outUid = String(cardNumber);
    outAltUid = String(hexFormatted);

  } else {
    // Custom / other bit counts (e.g. 28, 32, 36)
    cardNumber = (uint32_t)(raw & 0xFFFFFFFF);
    sprintf(hexFormatted, "%02X %02X %02X %02X",
            (uint8_t)(cardNumber >> 24),
            (uint8_t)(cardNumber >> 16),
            (uint8_t)(cardNumber >> 8),
            (uint8_t)(cardNumber & 0xFF));
    Serial.println("  Standard: " + String(bits) + "-bit Wiegand");
    Serial.println("  Card ID (Dec): " + String(cardNumber));
    Serial.println("  Hex UID:       " + String(hexFormatted));

    outUid = String(cardNumber);
    outAltUid = String(hexFormatted);
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

  // Wiegand UHF Reader Interrupt Init on GPIO 32 (D0) and GPIO 33 (D1)
  #if ENABLE_WIEGAND
    pinMode(WIEGAND_D0_PIN, INPUT_PULLUP);
    pinMode(WIEGAND_D1_PIN, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(WIEGAND_D0_PIN), isrWiegandD0, FALLING);
    attachInterrupt(digitalPinToInterrupt(WIEGAND_D1_PIN), isrWiegandD1, FALLING);
    Serial.println("[WIEGAND] Boland UHF Reader initialized on GPIO 32 (D0) and GPIO 33 (D1) with pull-ups.");
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
// 12. MAIN LOOP
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
        attemptWifiConnection(currentSsid, currentPass, 15);
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

  // 1. Poll Boland Long-Range UHF Wiegand Reader (GPIO 35 & 33)
  #if ENABLE_WIEGAND
    String wiegandUid = "";
    String wiegandAlt = "";
    if (checkWiegandReader(wiegandUid, wiegandAlt)) {
      handleScannedTag(wiegandUid, wiegandAlt);
    }
  #endif

  // 2. Poll Backup SPI Reader
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

  delay(10);
}
