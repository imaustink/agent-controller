/*
 * ws2812_test.ino
 * -------------------------------------------------------------
 * Test sketch for 2x WS2812 (NeoPixel) LEDs chained together,
 * driven from an ESP32.
 *
 * Wiring:
 *   ESP32 5V (VIN)  -> LED strip 5V   (if powering from USB; for
 *                      more than a couple LEDs use an external 5V
 *                      supply and share GND with the ESP32)
 *   ESP32 GND       -> LED strip GND
 *   ESP32 GPIO 5    -> LED strip DIN  (first LED's data input)
 *
 *   The two LEDs are chained: DOUT of LED #1 -> DIN of LED #2.
 *
 * Notes:
 *   - A 330-470 ohm resistor in series on the data line and a
 *     1000uF capacitor across 5V/GND are recommended but optional
 *     for just 2 LEDs.
 *   - WS2812 logic is 5V; the ESP32 outputs 3.3V. Two LEDs usually
 *     work fine at 3.3V data, but if you see glitches add a level
 *     shifter (e.g. 74AHCT125) on the data line.
 *
 * Library: Adafruit NeoPixel
 *   Install via Arduino IDE -> Library Manager -> "Adafruit NeoPixel"
 * -------------------------------------------------------------
 */

#include <Adafruit_NeoPixel.h>

#define LED_PIN    5     // GPIO data pin
#define LED_COUNT  2     // two LEDs chained
#define BRIGHTNESS 50    // 0-255; keep low so USB power is enough

Adafruit_NeoPixel strip(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("WS2812 2-LED test starting...");

  strip.begin();
  strip.setBrightness(BRIGHTNESS);
  strip.show();            // all pixels off
}

// Light one LED a given color, the other off. Helps confirm order
// and that each LED in the chain responds.
void testEach(uint32_t color, const char *name) {
  for (int i = 0; i < LED_COUNT; i++) {
    strip.clear();
    strip.setPixelColor(i, color);
    strip.show();
    Serial.print("LED ");
    Serial.print(i);
    Serial.print(" -> ");
    Serial.println(name);
    delay(600);
  }
}

// Set both LEDs to the same color.
void setBoth(uint32_t color, const char *name) {
  Serial.print("Both LEDs -> ");
  Serial.println(name);
  for (int i = 0; i < LED_COUNT; i++) strip.setPixelColor(i, color);
  strip.show();
  delay(800);
}

void loop() {
  // 1) Walk each LED through red/green/blue to verify addressing
  //    and the R/G/B channel order.
  Serial.println("--- Per-LED channel test ---");
  testEach(strip.Color(255, 0, 0), "RED");
  testEach(strip.Color(0, 255, 0), "GREEN");
  testEach(strip.Color(0, 0, 255), "BLUE");

  // 2) Both LEDs together through primary colors + white.
  Serial.println("--- Both-LED color test ---");
  setBoth(strip.Color(255, 0, 0),   "RED");
  setBoth(strip.Color(0, 255, 0),   "GREEN");
  setBoth(strip.Color(0, 0, 255),   "BLUE");
  setBoth(strip.Color(255, 255, 255), "WHITE");

  // 3) Smooth rainbow sweep across both LEDs.
  Serial.println("--- Rainbow sweep ---");
  for (long hue = 0; hue < 65536L; hue += 256) {
    strip.rainbow(hue, 1, 255, BRIGHTNESS, true);
    strip.show();
    delay(10);
  }

  // 4) Blank, then repeat.
  strip.clear();
  strip.show();
  delay(500);
}
