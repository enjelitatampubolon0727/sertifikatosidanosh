import { google } from 'googleapis';
import { JWT } from 'googleapis-common';

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets'
];

let authInstance: JWT | null = null;

export function getGoogleAuth(): JWT {
  if (authInstance) {
    return authInstance;
  }

  // For service account authentication
  // The service.json file should be placed in the project root or environment variables used
  try {
    const serviceAccountPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './service.json';

    authInstance = new google.auth.JWT({
      keyFile: serviceAccountPath,
      scopes: SCOPES,
    });

    return authInstance;
  } catch (error) {
    // Fallback to environment variables if service.json is not available
    const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!serviceAccountKey && (!clientEmail || !privateKey)) {
      throw new Error(
        'Google service account credentials not found. ' +
        'Please provide either GOOGLE_SERVICE_ACCOUNT_PATH or ' +
        'GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY environment variables.'
      );
    }

    if (serviceAccountKey) {
      // Parse service account key from environment variable
      const credentials = JSON.parse(serviceAccountKey);
      authInstance = new google.auth.JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: SCOPES,
      });
    } else {
      // Use individual environment variables
      authInstance = new google.auth.JWT({
        email: clientEmail,
        key: privateKey,
        scopes: SCOPES,
      });
    }

    return authInstance;
  }
}

export function resetGoogleAuth(): void {
  authInstance = null;
}

// Initialize Google Drive and Sheets clients
export function getDriveClient() {
  const auth = getGoogleAuth();
  return google.drive({ version: 'v3', auth });
}

export function getSheetsClient() {
  const auth = getGoogleAuth();
  return google.sheets({ version: 'v4', auth });
}