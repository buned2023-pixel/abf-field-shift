"""Test each API key from .env against its endpoint."""

import os
from dotenv import load_dotenv
import urllib.request
import urllib.error
import json

load_dotenv()

KEYS = {
    "IPSTACK_KEY": os.getenv("IPSTACK_KEY"),
    "WEATHERSTACK_KEY": os.getenv("WEATHERSTACK_KEY"),
    "FIRMS_MAP_KEY": os.getenv("FIRMS_MAP_KEY"),
}

ENDPOINTS = {
    "IPSTACK_KEY": "https://api.apilayer.net/ipstack/134.201.250.155?access_key={key}",
    "WEATHERSTACK_KEY": "https://api.apilayer.net/weatherstack/current?access_key={key}&query=London",
    "FIRMS_MAP_KEY": "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/VIIRS_SNPP_NRT/-125,24,-66,50/1",
}


def test_key(name: str, key: str, url_template: str) -> None:
    if not key:
        print(f"  {name}: MISSING (not set in .env)")
        return

    url = url_template.format(key=key)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "KeyTester/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            status = resp.status

        # --- ipstack / weatherstack return JSON with an "error" object on failure ---
        try:
            data = json.loads(body)
            if isinstance(data, dict) and "error" in data:
                err = data["error"]
                print(f"  {name}: INVALID  (API error {err.get('code')}: {err.get('info', err.get('type', 'unknown'))})")
                return
            if isinstance(data, dict) and "success" in data and not data["success"]:
                print(f"  {name}: INVALID  ({data.get('error', {}).get('info', 'unknown error')})")
                return
        except json.JSONDecodeError:
            pass  # non-JSON is fine (e.g. CSV from FIRMS)

        # If we got HTTP 200 with no error object, the key works
        print(f"  {name}: VALID    (HTTP {status}, response length {len(body)} bytes)")

    except urllib.error.HTTPError as exc:
        print(f"  {name}: INVALID  (HTTP {exc.code} {exc.reason})")
    except urllib.error.URLError as exc:
        print(f"  {name}: ERROR    (connection failed: {exc.reason})")
    except Exception as exc:
        print(f"  {name}: ERROR    ({exc})")


if __name__ == "__main__":
    print("Loaded keys from .env:")
    for name, val in KEYS.items():
        masked = f"{val[:6]}...{val[-4:]}" if val and len(val) > 10 else val
        print(f"  {name} = {masked}")

    print("\nTesting endpoints:")
    for name in KEYS:
        test_key(name, KEYS[name], ENDPOINTS[name])
