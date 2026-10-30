# Computer Systems Depot Intake System - Deployment Guide

## Overview

This guide will help you deploy and integrate the complete Computer Systems Depot intake system that replaces Captain Forms. The system includes:

- ✅ **Backend API**: Express.js with PostgreSQL database
- ✅ **Frontend Form**: React-based intake form with validation
- ✅ **Admin Dashboard**: View and manage intake submissions
- ✅ **Email Notifications**: SendGrid integration
- ✅ **WordPress Integration**: Custom plugin with shortcodes
- ✅ **Embeddable Widgets**: For any website
- ✅ **Source Tracking**: URL parameters and campaign attribution

---

## 1. Deploy the Replit Application

### Step 1: Update Database Schema

```bash
npm run db:push
```

This creates the new `csd_intake_records` table in your PostgreSQL database.

### Step 2: Configure Environment Variables

Add these environment variables to your Replit app:

```bash
# Required - Your existing database URL
DATABASE_URL=your_existing_neon_postgres_url

# Email Notifications (Optional but recommended)
SENDGRID_API_KEY=your_sendgrid_api_key
CSD_ADMIN_EMAIL=support@computersystemsdepot.com
CSD_FROM_EMAIL=noreply@computersystemsdepot.com

# Customer confirmation emails (Optional)
CSD_SEND_CUSTOMER_CONFIRMATION=true

# Your Replit domain for links in emails
REPLIT_DEV_DOMAIN=https://your-replit-app.repl.co
```

### Step 3: Test the Deployment

1. Start your Replit app: `npm run dev`
2. Test the public intake form: `https://your-app.repl.co/intake`
3. Test the embed version: `https://your-app.repl.co/embed`
4. Test the admin dashboard: `https://your-app.repl.co/admin/intakes`

---

## 2. WordPress Integration

### Option A: Install Custom Plugin (Recommended)

1. **Create Plugin ZIP file:**
   ```bash
   # Create a ZIP file with these files:
   wordpress-plugin/
   ├── csd-forms.php
   ├── assets/
   │   └── csd-forms.css
   └── readme.txt
   ```

2. **Install in WordPress:**
   - Upload ZIP file via WordPress Admin → Plugins → Add New → Upload Plugin
   - Activate the "Computer Systems Depot Forms" plugin

3. **Configure Plugin:**
   - Go to Settings → CSD Forms
   - Set "Replit Base URL" to your Replit app URL
   - Set "Default Source" to "WordPress Website"
   - Save settings

4. **Use Shortcodes:**
   ```html
   <!-- Basic form -->
   [csd_intake_form]

   <!-- Custom iframe -->
   [csd_form_embed width="100%" height="600px"]

   <!-- With tracking -->
   [csd_intake_form source="website_menu" campaign="spring_promo"]
   ```

### Option B: Direct HTML Embed

Add this HTML to any WordPress page:

```html
<iframe 
    src="https://your-replit-app.repl.co/embed?source=wordpress_direct" 
    width="100%" 
    height="800" 
    frameborder="0" 
    style="border: none; border-radius: 8px;"
    title="Computer Systems Depot Intake Form">
</iframe>
```

---

## 3. URL Setup for Phone Integration

### Create Clean URLs

1. **WordPress Permalink Setup:**
   - Go to Settings → Permalinks
   - Choose "Post name" or custom structure
   - Create a new page called "Start Service"
   - Set the slug to `start-service`
   - Add the `[csd_intake_form]` shortcode to the page

2. **Result:**
   - Clean URL: `https://www.computersystemsdepot.com/start-service`
   - With tracking: `https://www.computersystemsdepot.com/start-service?source=phone_call&call_id=12345`

### Phone System Integration

Configure your phone system to direct callers to:

```
https://www.computersystemsdepot.com/start-service?source=phone_call&call_id={CALL_ID}
```

The `call_id` parameter will be captured and stored with the intake record for tracking.

---

## 4. Email Notification Setup

### SendGrid Configuration

1. **Create SendGrid Account**: Sign up at [sendgrid.com](https://sendgrid.com)

2. **Create API Key**:
   - Go to Settings → API Keys
   - Create a new API key with "Mail Send" permissions
   - Add it to your Replit environment variables as `SENDGRID_API_KEY`

3. **Verify Sender Email**:
   - Go to Settings → Sender Authentication
   - Verify your `noreply@computersystemsdepot.com` email address

4. **Test Email Notifications**:
   - Submit a test intake form
   - Check your admin email for notification
   - Check spam folder if not received

### Email Templates

The system sends two types of emails:

1. **Admin Notification** (to `CSD_ADMIN_EMAIL`):
   - Contains all intake details
   - Includes source tracking information
   - Links to admin dashboard

2. **Customer Confirmation** (optional):
   - Thank you message to customer
   - Reference number for their records
   - Only sent if `CSD_SEND_CUSTOMER_CONFIRMATION=true`

---

## 5. Testing the Complete Flow

### Test Scenario 1: Website Form

1. Go to `https://www.computersystemsdepot.com/start-service`
2. Fill out the intake form completely
3. Submit the form
4. Verify:
   - Success message appears
   - Admin receives email notification
   - Record appears in `https://your-replit-app.repl.co/admin/intakes`
   - Source is tracked as "WordPress Website"

### Test Scenario 2: Phone Call Flow

1. Use URL: `https://www.computersystemsdepot.com/start-service?source=phone_call&call_id=TEST123`
2. Fill out the form and check "From active call"
3. Submit the form
4. Verify:
   - Source is tracked as "phone_call"
   - Call ID is captured as "TEST123"
   - "From active call" is marked as true

### Test Scenario 3: Campaign Tracking

1. Use URL: `https://www.computersystemsdepot.com/start-service?source=google_ads&campaign=repair_special`
2. Submit form
3. Verify tracking in admin dashboard

---

## 6. Admin Dashboard Usage

### Accessing the Dashboard

Go to: `https://your-replit-app.repl.co/admin/intakes`

### Dashboard Features

1. **Analytics Cards**:
   - Total intakes
   - Last 7 days count
   - Last 30 days count
   - Top source

2. **Filters**:
   - Date range (Today, Last 7 days, Last 30 days, All time)
   - Source filtering
   - Status filtering

3. **Intake Management**:
   - View detailed intake records
   - Update status (New → Contacted → Scheduled → Completed)
   - Track customer contact preferences
   - View source attribution and call notes

### Status Workflow

- **New**: Just submitted
- **Contacted**: Customer has been reached
- **Scheduled**: Appointment/service scheduled
- **Completed**: Service completed
- **Cancelled**: Cancelled by customer or business

---

## 7. Customization Options

### Branding

1. **Form Header**: Edit `client/src/pages/csd-intake.tsx`
2. **Email Templates**: Edit `server/csd-notifications.ts`
3. **Success Messages**: Edit `client/src/components/forms/csd-intake-form.tsx`

### Additional Fields

1. Add fields to schema in `shared/schema.ts`
2. Update form validation in `csd-intake-form.tsx`
3. Run `npm run db:push` to update database

### Form Validation

Edit the Zod schema in `csd-intake-form.tsx`:

```typescript
const csdIntakeFormSchema = z.object({
  // Add custom validation rules
  phoneNumber: z.string().regex(/^\(\d{3}\) \d{3}-\d{4}$/, "Please use format (555) 123-4567"),
  // ... other fields
});
```

---

## 8. Monitoring and Maintenance

### Database Monitoring

Check intake volume with SQL queries:

```sql
-- Daily intake count
SELECT DATE(created_at) as date, COUNT(*) as count 
FROM csd_intake_records 
GROUP BY DATE(created_at) 
ORDER BY date DESC LIMIT 30;

-- Source breakdown
SELECT source, COUNT(*) as count 
FROM csd_intake_records 
GROUP BY source 
ORDER BY count DESC;
```

### Error Monitoring

Check Replit logs for:
- Email delivery failures
- Database connection issues
- Form validation errors

### Backup Strategy

Your data is automatically backed up in Neon Database. For additional safety:
- Export intake data regularly from admin dashboard
- Keep environment variables documented
- Maintain copy of WordPress plugin files

---

## 9. Support and Troubleshooting

### Common Issues

1. **Form not submitting**:
   - Check Replit app is running
   - Verify CORS settings for WordPress domain
   - Check browser console for JavaScript errors

2. **Emails not sending**:
   - Verify SendGrid API key is correct
   - Check SendGrid sender authentication
   - Look for email failures in Replit logs

3. **WordPress plugin errors**:
   - Ensure plugin is activated
   - Check Replit URL in plugin settings
   - Verify shortcode syntax

4. **Tracking not working**:
   - Ensure URL parameters are properly formatted
   - Check that source/campaign values are being passed
   - Verify database schema is up to date

### Getting Help

- Check Replit app logs for error messages
- Use browser developer tools to debug form issues
- Verify all environment variables are set correctly
- Test each component individually (API, form, email, WordPress)

---

## 10. Next Steps

After successful deployment:

1. **Train staff** on using the admin dashboard
2. **Update phone system** with new intake URLs
3. **Add intake form links** to your website navigation
4. **Set up regular monitoring** of intake submissions
5. **Configure automated follow-up** workflows based on intake data

Your Computer Systems Depot intake system is now ready to replace Captain Forms with a more powerful, integrated solution!