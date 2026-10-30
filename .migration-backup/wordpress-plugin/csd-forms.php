<?php
/**
 * Plugin Name: Computer Systems Depot Forms
 * Plugin URI: https://computersystemsdepot.com
 * Description: Integration with Computer Systems Depot intake forms hosted on Replit
 * Version: 1.0.0
 * Author: Computer Systems Depot
 * License: GPL v2 or later
 */

// Prevent direct access
if (!defined('ABSPATH')) {
    exit;
}

class CSDForms {
    
    private $options;
    private $replit_base_url;
    
    public function __construct() {
        add_action('init', array($this, 'init'));
        add_action('admin_menu', array($this, 'add_admin_menu'));
        add_action('admin_init', array($this, 'settings_init'));
        add_action('wp_enqueue_scripts', array($this, 'enqueue_scripts'));
        
        // Register shortcodes
        add_shortcode('csd_intake_form', array($this, 'intake_form_shortcode'));
        add_shortcode('csd_form_embed', array($this, 'embed_form_shortcode'));
        add_shortcode('csd_remote_support', array($this, 'remote_support_shortcode'));
        
        // Get options
        $this->options = get_option('csd_forms_options');
        $this->replit_base_url = isset($this->options['replit_base_url']) 
            ? rtrim($this->options['replit_base_url'], '/') 
            : 'https://your-replit-app.repl.co';
    }
    
    public function init() {
        // Initialize plugin
    }
    
    public function add_admin_menu() {
        add_options_page(
            'CSD Forms Settings',
            'CSD Forms', 
            'manage_options',
            'csd_forms',
            array($this, 'options_page')
        );
    }
    
    public function settings_init() {
        register_setting('csd_forms', 'csd_forms_options');
        
        add_settings_section(
            'csd_forms_section',
            __('Computer Systems Depot Forms Settings'),
            array($this, 'settings_section_callback'),
            'csd_forms'
        );
        
        add_settings_field(
            'replit_base_url',
            __('Replit Base URL'),
            array($this, 'replit_base_url_render'),
            'csd_forms',
            'csd_forms_section'
        );
        
        add_settings_field(
            'api_key',
            __('API Key (optional)'),
            array($this, 'api_key_render'),
            'csd_forms',
            'csd_forms_section'
        );
        
        add_settings_field(
            'default_source',
            __('Default Source'),
            array($this, 'default_source_render'),
            'csd_forms',
            'csd_forms_section'
        );
    }
    
    public function replit_base_url_render() {
        ?>
        <input type='text' 
               name='csd_forms_options[replit_base_url]' 
               value='<?php echo isset($this->options['replit_base_url']) ? esc_attr($this->options['replit_base_url']) : ''; ?>'
               size='50'
               placeholder='https://your-replit-app.repl.co'>
        <p class="description">Your Replit app URL (without trailing slash)</p>
        <?php
    }
    
    public function api_key_render() {
        ?>
        <input type='text' 
               name='csd_forms_options[api_key]' 
               value='<?php echo isset($this->options['api_key']) ? esc_attr($this->options['api_key']) : ''; ?>'
               size='50'
               placeholder='Optional API key for authentication'>
        <p class="description">Leave blank if no API authentication is required</p>
        <?php
    }
    
    public function default_source_render() {
        ?>
        <input type='text' 
               name='csd_forms_options[default_source]' 
               value='<?php echo isset($this->options['default_source']) ? esc_attr($this->options['default_source']) : 'WordPress Website'; ?>'
               size='30'
               placeholder='WordPress Website'>
        <p class="description">Default source attribution for forms on this website</p>
        <?php
    }
    
    public function settings_section_callback() {
        echo __('Configure your Computer Systems Depot forms integration settings below.');
    }
    
    public function options_page() {
        ?>
        <div class="wrap">
            <h1>Computer Systems Depot Forms Settings</h1>
            <form action='options.php' method='post'>
                <?php
                settings_fields('csd_forms');
                do_settings_sections('csd_forms');
                submit_button();
                ?>
            </form>
            
            <div style="margin-top: 30px; padding: 15px; background: #f0f8ff; border: 1px solid #ddd;">
                <h3>Usage Instructions</h3>
                <h4>Shortcodes:</h4>
                <ul>
                    <li><code>[csd_intake_form]</code> - Display full intake form</li>
                    <li><code>[csd_form_embed width="100%" height="800px"]</code> - Embed form via iframe</li>
                </ul>
                
                <h4>URL Parameters:</h4>
                <p>You can add tracking parameters to any page with the form:</p>
                <ul>
                    <li><code>?source=phone_call</code> - Track source</li>
                    <li><code>?campaign=google_ads</code> - Track campaign</li>
                    <li><code>?call_id=12345</code> - Tie to phone system</li>
                </ul>
                
                <h4>Example Links:</h4>
                <ul>
                    <li><code><?php echo home_url('/start-service'); ?></code> - Clean link for customers</li>
                    <li><code><?php echo home_url('/start-service?source=phone_call&call_id=12345'); ?></code> - Phone system link</li>
                </ul>
            </div>
        </div>
        <?php
    }
    
    public function enqueue_scripts() {
        // Enqueue styles for forms
        wp_enqueue_style(
            'csd-forms-style',
            plugin_dir_url(__FILE__) . 'assets/csd-forms.css',
            array(),
            '1.0.0'
        );
    }
    
    /**
     * Shortcode: [csd_intake_form]
     * Display the intake form embedded via JavaScript
     */
    public function intake_form_shortcode($atts) {
        $atts = shortcode_atts(array(
            'source' => isset($this->options['default_source']) ? $this->options['default_source'] : 'WordPress Website',
            'campaign' => '',
            'width' => '100%',
            'height' => 'auto',
            'class' => 'csd-intake-form'
        ), $atts, 'csd_intake_form');
        
        // Build URL with parameters
        $form_url = $this->replit_base_url . '/intake';
        $params = array();
        
        if (!empty($atts['source'])) {
            $params['source'] = $atts['source'];
        }
        if (!empty($atts['campaign'])) {
            $params['campaign'] = $atts['campaign'];
        }
        
        // Add URL parameters from current page
        if (!empty($_GET['source'])) {
            $params['source'] = sanitize_text_field($_GET['source']);
        }
        if (!empty($_GET['campaign'])) {
            $params['campaign'] = sanitize_text_field($_GET['campaign']);
        }
        if (!empty($_GET['call_id'])) {
            $params['call_id'] = sanitize_text_field($_GET['call_id']);
        }
        
        if (!empty($params)) {
            $form_url .= '?' . http_build_query($params);
        }
        
        $container_id = 'csd-form-container-' . uniqid();
        
        ob_start();
        ?>
        <div id="<?php echo esc_attr($container_id); ?>" 
             class="<?php echo esc_attr($atts['class']); ?>" 
             style="width: <?php echo esc_attr($atts['width']); ?>; height: <?php echo esc_attr($atts['height']); ?>;">
            <div class="csd-form-loading">
                <p>Loading Computer Systems Depot service request form...</p>
            </div>
        </div>
        
        <script>
        (function() {
            var iframe = document.createElement('iframe');
            iframe.src = '<?php echo esc_js($form_url); ?>';
            iframe.width = '100%';
            iframe.height = '800';
            iframe.frameBorder = '0';
            iframe.style.border = 'none';
            iframe.style.borderRadius = '8px';
            iframe.setAttribute('title', 'Computer Systems Depot Intake Form');
            
            var container = document.getElementById('<?php echo esc_js($container_id); ?>');
            container.innerHTML = '';
            container.appendChild(iframe);
            
            // Auto-resize iframe based on content (if supported)
            iframe.onload = function() {
                try {
                    var iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                    if (iframeDoc) {
                        var height = iframeDoc.body.scrollHeight;
                        if (height > 400) {
                            iframe.height = height + 50;
                        }
                    }
                } catch (e) {
                    // Cross-origin restrictions - use default height
                }
            };
        })();
        </script>
        <?php
        return ob_get_clean();
    }
    
    /**
     * Shortcode: [csd_form_embed]
     * Simple iframe embed
     */
    public function embed_form_shortcode($atts) {
        $atts = shortcode_atts(array(
            'width' => '100%',
            'height' => '800px',
            'source' => isset($this->options['default_source']) ? $this->options['default_source'] : 'WordPress Website',
            'campaign' => ''
        ), $atts, 'csd_form_embed');
        
        $form_url = $this->replit_base_url . '/intake';
        $params = array();
        
        if (!empty($atts['source'])) {
            $params['source'] = $atts['source'];
        }
        if (!empty($atts['campaign'])) {
            $params['campaign'] = $atts['campaign'];
        }
        
        // Add URL parameters from current page
        if (!empty($_GET['source'])) {
            $params['source'] = sanitize_text_field($_GET['source']);
        }
        if (!empty($_GET['campaign'])) {
            $params['campaign'] = sanitize_text_field($_GET['campaign']);
        }
        if (!empty($_GET['call_id'])) {
            $params['call_id'] = sanitize_text_field($_GET['call_id']);
        }
        
        if (!empty($params)) {
            $form_url .= '?' . http_build_query($params);
        }
        
        return sprintf(
            '<iframe src="%s" width="%s" height="%s" frameborder="0" style="border: none; border-radius: 8px;" title="Computer Systems Depot Intake Form"></iframe>',
            esc_attr($form_url),
            esc_attr($atts['width']),
            esc_attr($atts['height'])
        );
    }

    /**
     * Shortcode: [csd_remote_support]
     * Embeds the secure Remote Support code widget (served same-origin by the
     * app at /remote-support). A customer enters the 6-digit code a technician
     * gave them over the phone and is connected to a MeshCentral session.
     * Usage: [csd_remote_support height="560px"]
     */
    public function remote_support_shortcode($atts) {
        $atts = shortcode_atts(array(
            'width'  => '100%',
            'height' => '560px'
        ), $atts, 'csd_remote_support');

        $widget_url = $this->replit_base_url . '/remote-support';

        return sprintf(
            '<iframe src="%s" width="%s" height="%s" frameborder="0" style="border: none;" title="Computer Systems Depot Remote Support" allow="fullscreen"></iframe>',
            esc_attr($widget_url),
            esc_attr($atts['width']),
            esc_attr($atts['height'])
        );
    }
}

// Initialize the plugin
new CSDForms();

// Activation hook
register_activation_hook(__FILE__, 'csd_forms_activate');
function csd_forms_activate() {
    // Set default options
    $default_options = array(
        'replit_base_url' => 'https://your-replit-app.repl.co',
        'api_key' => '',
        'default_source' => 'WordPress Website'
    );
    add_option('csd_forms_options', $default_options);
}

// Deactivation hook
register_deactivation_hook(__FILE__, 'csd_forms_deactivate');
function csd_forms_deactivate() {
    // Cleanup if needed
}
?>