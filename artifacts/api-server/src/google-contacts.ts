import { google } from 'googleapis';

// googleapis bundles its own copy of google-auth-library, so importing
// OAuth2Client from the standalone package names a *different* class than the
// one `google.auth.OAuth2` actually constructs and `google.people({ auth })`
// actually accepts. Deriving the type from googleapis keeps both sides on the
// single version that is really in play.
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

const SCOPES = ['https://www.googleapis.com/auth/contacts'];

interface GoogleContactData {
  fullName: string;
  email?: string | null;
  mobilePhone?: string | null;
  officePhone?: string | null;
  company?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  notes?: string | null;
}

class GoogleContactsService {
  private oauth2Client: OAuth2Client | null = null;
  private isConfigured: boolean = false;

  constructor() {
    this.initialize();
  }

  private initialize() {
    try {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/google/callback';

      if (clientId && clientSecret) {
        this.oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        
        const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
        const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
        
        if (accessToken || refreshToken) {
          this.oauth2Client.setCredentials({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          this.isConfigured = true;
          console.log('Google Contacts service initialized with stored tokens');
        } else {
          console.log('Google Contacts: Credentials configured, but no tokens. Run OAuth flow to authorize.');
        }
      } else {
        console.log('Google Contacts: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET not set. OAuth setup required.');
      }
    } catch (error) {
      console.error('Failed to initialize Google Contacts service:', error);
    }
  }

  getStatus(): { configured: boolean; hasCredentials: boolean; hasToken: boolean } {
    const hasCredentials = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    const hasToken = !!(process.env.GOOGLE_ACCESS_TOKEN || process.env.GOOGLE_REFRESH_TOKEN);
    
    return {
      configured: this.isConfigured,
      hasCredentials,
      hasToken,
    };
  }

  getAuthUrl(): string | null {
    if (!this.oauth2Client) {
      return null;
    }
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
    });
  }

  async handleAuthCallback(code: string): Promise<{ accessToken: string; refreshToken: string }> {
    if (!this.oauth2Client) {
      throw new Error('OAuth client not initialized. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
    }
    
    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      this.oauth2Client.setCredentials(tokens);
      this.isConfigured = true;
      console.log('Google Contacts: Token obtained successfully');
      
      return {
        accessToken: tokens.access_token || '',
        refreshToken: tokens.refresh_token || '',
      };
    } catch (error) {
      console.error('Error getting token:', error);
      throw error;
    }
  }

  async createContact(contactData: GoogleContactData): Promise<{ resourceName: string; etag: string } | null> {
    if (!this.isConfigured || !this.oauth2Client) {
      console.log('Google Contacts not configured - skipping sync');
      return null;
    }

    const people = google.people({ version: 'v1', auth: this.oauth2Client });

    const personData: any = {
      names: [{ givenName: contactData.fullName }],
    };

    if (contactData.email) {
      personData.emailAddresses = [{ value: contactData.email, type: 'work' }];
    }

    const phoneNumbers: any[] = [];
    if (contactData.mobilePhone) {
      phoneNumbers.push({ value: contactData.mobilePhone, type: 'mobile' });
    }
    if (contactData.officePhone) {
      phoneNumbers.push({ value: contactData.officePhone, type: 'work' });
    }
    if (phoneNumbers.length > 0) {
      personData.phoneNumbers = phoneNumbers;
    }

    if (contactData.company) {
      personData.organizations = [{ name: contactData.company }];
    }

    if (contactData.address || contactData.city || contactData.state || contactData.zipCode) {
      personData.addresses = [{
        streetAddress: contactData.address || undefined,
        city: contactData.city || undefined,
        region: contactData.state || undefined,
        postalCode: contactData.zipCode || undefined,
        type: 'home'
      }];
    }

    if (contactData.notes) {
      personData.biographies = [{ value: contactData.notes, contentType: 'TEXT_PLAIN' }];
    }

    try {
      const response = await people.people.createContact({
        requestBody: personData,
      });

      console.log(`Google Contact created: ${contactData.fullName}`);
      return {
        resourceName: response.data.resourceName || '',
        etag: response.data.etag || '',
      };
    } catch (error: any) {
      console.error('Failed to create Google Contact:', error.message);
      throw error;
    }
  }

  async searchContact(query: string): Promise<any[]> {
    if (!this.isConfigured || !this.oauth2Client) {
      return [];
    }

    const people = google.people({ version: 'v1', auth: this.oauth2Client });

    try {
      const response = await people.people.searchContacts({
        query,
        readMask: 'names,emailAddresses,phoneNumbers',
        pageSize: 10,
      });

      return response.data.results || [];
    } catch (error: any) {
      console.error('Failed to search Google Contacts:', error.message);
      return [];
    }
  }

  async deleteContact(resourceName: string): Promise<boolean> {
    if (!this.isConfigured || !this.oauth2Client) {
      return false;
    }

    const people = google.people({ version: 'v1', auth: this.oauth2Client });

    try {
      await people.people.deleteContact({ resourceName });
      console.log(`Google Contact deleted: ${resourceName}`);
      return true;
    } catch (error: any) {
      console.error('Failed to delete Google Contact:', error.message);
      return false;
    }
  }

  async listAllContacts(pageSize: number = 100): Promise<GoogleContactData[]> {
    if (!this.isConfigured || !this.oauth2Client) {
      console.log('Google Contacts not configured - cannot list contacts');
      return [];
    }

    const people = google.people({ version: 'v1', auth: this.oauth2Client });
    const allContacts: GoogleContactData[] = [];
    let nextPageToken: string | undefined;

    try {
      do {
        const response = await people.people.connections.list({
          resourceName: 'people/me',
          pageSize,
          personFields: 'names,emailAddresses,phoneNumbers,organizations,addresses,biographies',
          pageToken: nextPageToken,
        });

        const connections = response.data.connections || [];
        
        for (const person of connections) {
          const contact: GoogleContactData & { resourceName?: string } = {
            fullName: person.names?.[0]?.displayName || person.names?.[0]?.givenName || 'Unknown',
            email: person.emailAddresses?.[0]?.value || null,
            mobilePhone: person.phoneNumbers?.find(p => p.type === 'mobile')?.value || 
                         person.phoneNumbers?.[0]?.value || null,
            officePhone: person.phoneNumbers?.find(p => p.type === 'work')?.value || null,
            company: person.organizations?.[0]?.name || null,
            address: person.addresses?.[0]?.streetAddress || null,
            city: person.addresses?.[0]?.city || null,
            state: person.addresses?.[0]?.region || null,
            zipCode: person.addresses?.[0]?.postalCode || null,
            notes: person.biographies?.[0]?.value || null,
          };
          
          // Add the Google resource name for linking
          (contact as any).googleContactId = person.resourceName || null;
          
          allContacts.push(contact);
        }

        nextPageToken = response.data.nextPageToken || undefined;
      } while (nextPageToken);

      console.log(`Fetched ${allContacts.length} contacts from Google account`);
      return allContacts;
    } catch (error: any) {
      console.error('Failed to list Google Contacts:', error.message);
      throw error;
    }
  }

  async getContactCount(): Promise<number> {
    if (!this.isConfigured || !this.oauth2Client) {
      return 0;
    }

    const people = google.people({ version: 'v1', auth: this.oauth2Client });

    try {
      const response = await people.people.connections.list({
        resourceName: 'people/me',
        pageSize: 1,
        personFields: 'names',
      });

      return response.data.totalPeople || 0;
    } catch (error: any) {
      console.error('Failed to get contact count:', error.message);
      return 0;
    }
  }

  reinitialize() {
    this.initialize();
  }
}

export const googleContactsService = new GoogleContactsService();
