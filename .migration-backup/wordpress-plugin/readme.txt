=== Computer Systems Depot Forms ===
Contributors: computersystemsdepot
Tags: forms, intake, crm, computer repair
Requires at least: 5.0
Tested up to: 6.4
Stable tag: 1.0.0
Requires PHP: 7.4
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Integrate Computer Systems Depot intake forms hosted on Replit with your WordPress website.

== Description ==

Computer Systems Depot Forms plugin allows you to seamlessly integrate your Replit-hosted intake forms with your WordPress website. Perfect for computer repair businesses that want to capture customer service requests directly on their website.

**Features:**

* Easy shortcode integration `[csd_intake_form]`
* Iframe embedding option `[csd_form_embed]`
* Source and campaign tracking
* Mobile-responsive design
* Phone system integration support
* Admin settings panel

**Use Cases:**

* Customer intake forms on your main website
* Service request forms linked from phone systems
* Campaign tracking for marketing attribution
* Mobile-friendly service request submission

== Installation ==

1. Upload the plugin files to the `/wp-content/plugins/csd-forms` directory, or install the plugin through the WordPress plugins screen directly.
2. Activate the plugin through the 'Plugins' screen in WordPress
3. Use the Settings->CSD Forms screen to configure the plugin
4. Add your Replit app URL in the settings
5. Use shortcodes `[csd_intake_form]` or `[csd_form_embed]` in your pages/posts

== Frequently Asked Questions ==

= How do I get a Replit app URL? =

You need to deploy your Computer Systems Depot intake app on Replit. The URL will look like `https://your-app-name.repl.co`

= Can I track different sources? =

Yes! Use URL parameters like `?source=phone_call` or add source attributes to shortcodes.

= Does it work on mobile? =

Yes, the forms are fully responsive and work great on mobile devices.

= Can I customize the appearance? =

Yes, you can add custom CSS to match your website's design. The plugin provides CSS classes for styling.

== Changelog ==

= 1.0.0 =
* Initial release
* Shortcode integration
* Iframe embedding
* Source tracking
* Admin settings panel

== Upgrade Notice ==

= 1.0.0 =
Initial release of Computer Systems Depot Forms integration plugin.

== Screenshots ==

1. Admin settings page
2. Intake form embedded in page
3. Mobile responsive design

== Usage Examples ==

**Basic form:**
`[csd_intake_form]`

**Custom iframe:**
`[csd_form_embed width="100%" height="600px"]`

**With source tracking:**
`[csd_intake_form source="website_menu" campaign="spring_promo"]`

**URL with parameters:**
`https://yoursite.com/start-service?source=phone_call&call_id=12345`