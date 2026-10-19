import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PORT,
  DUFFEL_BASE_URL,
  DUFFEL_ACCESS_TOKEN,
  COMPANY
} from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const DATA_DIR = path.join(__dirname, "..", "data");
const ENQUIRIES_FILE = path.join(DATA_DIR, "enquiries.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(ENQUIRIES_FILE)) {
  fs.writeFileSync(ENQUIRIES_FILE, "[]", "utf8");
}

const app = express();

app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false
  })
);

app.use(express.json({ limit: "150kb" }));
app.use(express.urlencoded({ extended: true, limit: "150kb" }));

app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false
  })
);

app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found."
  });
});


function apiError(message, status = 500, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

async function parseResponse(response) {
  const raw = await response.text();

  let payload = null;

  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
  }

  if (!response.ok) {
    const message =
      payload?.errors?.[0]?.message ||
      payload?.message ||
      "External API request failed.";

    throw apiError(message, response.status, payload);
  }

  return payload;
}

async function duffelRequest(
  endpoint,
  {
    method = "GET",
    body = null,
    extraHeaders = {}
  } = {}
) {
  const headers = {
    Accept: "application/json",
    "Duffel-Version": "v2",
    Authorization: "Bearer " + DUFFEL_ACCESS_TOKEN,
    ...extraHeaders
  };

  if (body !== null) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(DUFFEL_BASE_URL + endpoint, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(130000)
  });

  return parseResponse(response);
}

function validateIata(value, fieldName) {
  const code = String(value || "")
    .trim()
    .toUpperCase();

  if (!/^[A-Z]{3}$/.test(code)) {
    throw apiError(fieldName + " must be a valid 3-letter IATA code.", 400);
  }

  return code;
}

function validateDate(value, fieldName) {
  const date = String(value || "");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw apiError(fieldName + " must be YYYY-MM-DD.", 400);
  }

  return date;
}

function passengerList(adults, children, infants) {
  const result = [];

  for (let i = 0; i < adults; i += 1) {
    result.push({ type: "adult" });
  }

  for (let i = 0; i < children; i += 1) {
    result.push({ age: 8 });
  }

  for (let i = 0; i < infants; i += 1) {
    result.push({ age: 1 });
  }

  return result;
}

function normaliseCount(value, fallback = 0, max = 9) {
  const number = Number.parseInt(value, 10);

  if (Number.isNaN(number)) {
    return fallback;
  }

  return Math.max(0, Math.min(max, number));
}

function getDuffelErrorCode(error) {
  return error?.details?.errors?.[0]?.code || "";
}

/* =========================================================
   STATUS
========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    company: COMPANY.name,
    duffelMode: "test",
    timestamp: new Date().toISOString()
  });
});

/* =========================================================
   PLACES / AIRPORT AUTOCOMPLETE
========================================================= */

app.get("/api/places", async (req, res, next) => {
  try {
    const query = String(req.query.q || "").trim();

    if (query.length < 2) {
      return res.json([]);
    }

    const result = await duffelRequest(
      "/places/suggestions?query=" + encodeURIComponent(query)
    );

    const places = Array.isArray(result?.data) ? result.data : [];

    res.json(
      places.slice(0, 10).map((place) => ({
        id: place.id,
        type: place.type,
        name: place.name,
        cityName: place.city_name || place.name,
        iataCode: place.iata_code,
        countryCode: place.iata_country_code,
        latitude: place.latitude,
        longitude: place.longitude,
        airports: place.airports || []
      }))
    );
  } catch (error) {
    next(error);
  }
});

/* =========================================================
   FLIGHT SEARCH
========================================================= */

app.post("/api/flights/search", async (req, res, next) => {
  try {
    const origin = validateIata(req.body.origin, "Origin");
    const destination = validateIata(req.body.destination, "Destination");

    const departureDate = validateDate(
      req.body.departureDate,
      "Departure date"
    );

    const returnDate = req.body.returnDate
      ? validateDate(req.body.returnDate, "Return date")
      : null;

    const adults = normaliseCount(req.body.adults, 1);
    const children = normaliseCount(req.body.children, 0);
    const infants = normaliseCount(req.body.infants, 0);

    if (adults < 1) {
      throw apiError("At least one adult traveller is required.", 400);
    }

    if (adults + children + infants > 9) {
      throw apiError("Duffel supports a maximum of 9 passengers per order.", 400);
    }

    const allowedCabins = [
      "economy",
      "premium_economy",
      "business",
      "first"
    ];

    const cabinClass = allowedCabins.includes(req.body.cabinClass)
      ? req.body.cabinClass
      : "economy";

    const slices = [
      {
        origin,
        destination,
        departure_date: departureDate
      }
    ];

    if (returnDate) {
      if (returnDate < departureDate) {
        throw apiError(
          "Return date cannot be before the departure date.",
          400
        );
      }

      slices.push({
        origin: destination,
        destination: origin,
        departure_date: returnDate
      });
    }

    const data = await duffelRequest(
      "/air/offer_requests?return_offers=true&supplier_timeout=15000",
      {
        method: "POST",
        body: {
          data: {
            slices,
            passengers: passengerList(adults, children, infants),
            cabin_class: cabinClass
          }
        }
      }
    );

    res.json({
      offerRequestId: data?.data?.id,
      liveMode: data?.data?.live_mode,
      offers: data?.data?.offers || []
    });
  } catch (error) {
    next(error);
  }
});

/* =========================================================
   SINGLE FLIGHT OFFER
========================================================= */

app.get("/api/flights/offers/:id", async (req, res, next) => {
  try {
    const id = encodeURIComponent(req.params.id);

    const data = await duffelRequest(
      "/air/offers/" + id + "?return_available_services=true"
    );

    res.json(data.data);
  } catch (error) {
    next(error);
  }
});

/* =========================================================
   TEST FLIGHT BOOKING
========================================================= */

app.post("/api/flights/book", async (req, res, next) => {
  try {
    const offerId = String(req.body.offerId || "").trim();
    const passengerDetails = Array.isArray(req.body.passengers)
      ? req.body.passengers
      : [];

    if (!offerId) {
      throw apiError("Missing offer ID.", 400);
    }

    /*
     * Always retrieve the offer again immediately before booking.
     * Airline prices/availability can change after search.
     */
    const latest = await duffelRequest(
      "/air/offers/" +
        encodeURIComponent(offerId) +
        "?return_available_services=true"
    );

    const offer = latest.data;
    const offerPassengers = Array.isArray(offer.passengers)
      ? offer.passengers
      : [];

    if (passengerDetails.length !== offerPassengers.length) {
      throw apiError(
        "Passenger details do not match the selected offer.",
        400
      );
    }

    const passengers = offerPassengers.map((offerPassenger, index) => {
      const submitted = passengerDetails[index] || {};

      const givenName = String(submitted.givenName || "").trim();
      const familyName = String(submitted.familyName || "").trim();
      const email = String(submitted.email || "").trim();
      const phoneNumber = String(submitted.phoneNumber || "").trim();
      const bornOn = String(submitted.bornOn || "").trim();

      if (!givenName || !familyName || !bornOn) {
        throw apiError(
          "Each passenger requires first name, surname and date of birth.",
          400
        );
      }

      const passenger = {
        id: offerPassenger.id,
        title: submitted.title || "mr",
        given_name: givenName,
        family_name: familyName,
        born_on: bornOn,
        gender: submitted.gender === "f" ? "f" : "m",
        email: email || "info@positivegloballtd.co.uk",
        phone_number: phoneNumber || "+20200000000"
      };

      const passportNumber = String(
        submitted.passportNumber || ""
      ).trim();

      const passportCountry = String(
        submitted.passportCountry || ""
      )
        .trim()
        .toUpperCase();

      const passportExpiry = String(
        submitted.passportExpiry || ""
      ).trim();

      if (passportNumber && passportCountry && passportExpiry) {
        passenger.identity_documents = [
          {
            type: "passport",
            unique_identifier: passportNumber,
            issuing_country_code: passportCountry,
            expires_on: passportExpiry
          }
        ];
      }

      return passenger;
    });

    const order = await duffelRequest("/air/orders", {
      method: "POST",
      body: {
        data: {
          type: "instant",
          selected_offers: [offer.id],
          passengers,
          payments: [
            {
              type: "balance",
              currency: offer.total_currency,
              amount: offer.total_amount
            }
          ],
          metadata: {
            website: "positive-global-travel",
            environment: "test"
          }
        }
      }
    });

    res.status(201).json(order.data);
  } catch (error) {
    next(error);
  }
});

/* =========================================================
   HOTEL SEARCH
   Automatically becomes live once Duffel Stays is enabled
   for this Duffel organisation/token.
========================================================= */

async function findDestinationCoordinates(query) {
  const result = await duffelRequest(
    "/places/suggestions?query=" + encodeURIComponent(query)
  );

  const places = Array.isArray(result?.data) ? result.data : [];

  const withCoordinates = places.find(
    (place) =>
      typeof place.latitude === "number" &&
      typeof place.longitude === "number"
  );

  if (withCoordinates) {
    return {
      latitude: withCoordinates.latitude,
      longitude: withCoordinates.longitude,
      label:
        withCoordinates.city_name ||
        withCoordinates.name ||
        query
    };
  }

  for (const place of places) {
    const airport = Array.isArray(place.airports)
      ? place.airports.find(
          (candidate) =>
            typeof candidate.latitude === "number" &&
            typeof candidate.longitude === "number"
        )
      : null;

    if (airport) {
      return {
        latitude: airport.latitude,
        longitude: airport.longitude,
        label: place.name || airport.city_name || query
      };
    }
  }

  throw apiError(
    "We could not locate that destination. Try a city or airport name.",
    404
  );
}

app.post("/api/hotels/search", async (req, res, next) => {
  try {
    const destination = String(req.body.destination || "").trim();

    if (destination.length < 2) {
      throw apiError("Please enter a hotel destination.", 400);
    }

    const checkInDate = validateDate(
      req.body.checkInDate,
      "Check-in date"
    );

    const checkOutDate = validateDate(
      req.body.checkOutDate,
      "Check-out date"
    );

    if (checkOutDate <= checkInDate) {
      throw apiError(
        "Check-out date must be after check-in date.",
        400
      );
    }

    const adults = Math.max(
      1,
      normaliseCount(req.body.adults, 2)
    );

    const children = normaliseCount(req.body.children, 0);
    const rooms = Math.max(
      1,
      normaliseCount(req.body.rooms, 1)
    );

    if (adults < rooms) {
      throw apiError(
        "There must be at least one adult per room.",
        400
      );
    }

    const coordinates = await findDestinationCoordinates(destination);

    const guests = [];

    for (let i = 0; i < adults; i += 1) {
      guests.push({ type: "adult" });
    }

    for (let i = 0; i < children; i += 1) {
      guests.push({
        type: "child",
        age: 8
      });
    }

    try {
      const result = await duffelRequest("/stays/search", {
        method: "POST",
        body: {
          data: {
            rooms,
            guests,
            check_in_date: checkInDate,
            check_out_date: checkOutDate,
            mobile: false,
            free_cancellation_only: false,
            location: {
              radius: 20,
              geographic_coordinates: {
                latitude: coordinates.latitude,
                longitude: coordinates.longitude
              }
            }
          }
        }
      });

      return res.json({
        staysAccess: true,
        destination: coordinates,
        search: result.data
      });
    } catch (error) {
      if (
        error.status === 403 ||
        getDuffelErrorCode(error) === "insufficient_permissions"
      ) {
        return res.status(403).json({
          staysAccess: false,
          code: "STAYS_ACCESS_REQUIRED",
          message:
            "Duffel Stays has not yet been enabled for this account."
        });
      }

      throw error;
    }
  } catch (error) {
    next(error);
  }
});

/* =========================================================
   HOTEL RATES
========================================================= */

app.post(
  "/api/hotels/search-results/:id/rates",
  async (req, res, next) => {
    try {
      const id = encodeURIComponent(req.params.id);

      const result = await duffelRequest(
        "/stays/search_results/" +
          id +
          "/actions/fetch_all_rates",
        {
          method: "POST",
          body: {
            data: {}
          }
        }
      );

      res.json(result.data);
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   HOTEL QUOTE
========================================================= */

app.post("/api/hotels/quotes", async (req, res, next) => {
  try {
    const rateId = String(req.body.rateId || "").trim();

    if (!rateId) {
      throw apiError("Missing hotel rate ID.", 400);
    }

    const result = await duffelRequest("/stays/quotes", {
      method: "POST",
      body: {
        data: {
          rate_id: rateId
        }
      }
    });

    res.json(result.data);
  } catch (error) {
    next(error);
  }
});

/* =========================================================
   CURRENCY CONVERSION
   Public demo FX source with fallback values.
   For production choose a commercial FX provider/plan.
========================================================= */

let fxCache = {
  timestamp: 0,
  payload: null
};

app.get("/api/fx", async (req, res) => {
  const oneHour = 60 * 60 * 1000;

  if (
    fxCache.payload &&
    Date.now() - fxCache.timestamp < oneHour
  ) {
    return res.json(fxCache.payload);
  }

  try {
    const response = await fetch(
      "https://open.er-api.com/v6/latest/GBP",
      {
        signal: AbortSignal.timeout(8000)
      }
    );

    if (!response.ok) {
      throw new Error("FX provider unavailable.");
    }

    const data = await response.json();

    const payload = {
      base: "GBP",
      rates: data.rates,
      updatedAt: data.time_last_update_utc || null,
      fallback: false
    };

    fxCache = {
      timestamp: Date.now(),
      payload
    };

    return res.json(payload);
  } catch {
    const payload = {
      base: "GBP",
      rates: {
        GBP: 1,
        USD: 1.33,
        EUR: 1.15,
        SAR: 4.99,
        EGP: 64
      },
      fallback: true
    };

    res.json(payload);
  }
});

/* =========================================================
   CONTACT FORM
========================================================= */

app.post("/api/contact", (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim();
    const phone = String(req.body.phone || "").trim();
    const message = String(req.body.message || "").trim();

    if (!name || !email || !message) {
      throw apiError(
        "Name, email and message are required.",
        400
      );
    }

    const enquiries = JSON.parse(
      fs.readFileSync(ENQUIRIES_FILE, "utf8")
    );

    const enquiry = {
      id: "ENQ-" + Date.now(),
      name,
      email,
      phone,
      message,
      createdAt: new Date().toISOString()
    };

    enquiries.push(enquiry);

    fs.writeFileSync(
      ENQUIRIES_FILE,
      JSON.stringify(enquiries, null, 2),
      "utf8"
    );

    res.status(201).json({
      ok: true,
      reference: enquiry.id
    });
  } catch (error) {
    next(error);
  }
});

/* =========================================================
   API 404
========================================================= */

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API endpoint not found."
  });
});

/* =========================================================
   WEBSITE 404
========================================================= */

app.use((req, res) => {
  res
    .status(404)
    .sendFile(path.join(PUBLIC_DIR, "404.html"));
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
  console.error(error);

  const status =
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
      ? error.status
      : 500;

  res.status(status).json({
    error: error.message || "Unexpected server error.",
    details:
      process.env.NODE_ENV === "development"
        ? error.details
        : undefined
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("Positive Global Travel");
  console.log("----------------------");
  console.log("Website: http://localhost:" + PORT);
  console.log("Duffel:  TEST MODE");
  console.log("");
});
