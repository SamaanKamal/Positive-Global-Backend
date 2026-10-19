export const PORT = Number(process.env.PORT || 8000);

export const DUFFEL_BASE_URL = "https://api.duffel.com";

/*
 * TEST TOKEN HARDCODED AS REQUESTED.
 *
 * IMPORTANT:
 * This file is SERVER-SIDE only.
 * Never move this token to /public/scripts/.
 */
export const DUFFEL_ACCESS_TOKEN = process.env.DUFFEL_ACCESS_TOKEN;

export const COMPANY = {
  name: "Positive Global Travel",
  email: "info@positivegloballtd.co.uk",
  phone: "+20 2 0000 0000",
  address: "Cairo, Egypt"
};
