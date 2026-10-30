import { useEffect, useState } from "react";
import CsdIntakeForm from "@/components/forms/csd-intake-form";

/**
 * Embeddable page for iframe integration
 * This page is designed to be embedded in other websites
 */
export default function EmbedPage() {
  const [parentOrigin, setParentOrigin] = useState<string>("");

  useEffect(() => {
    // Track parent origin for security
    if (window.parent !== window) {
      setParentOrigin(document.referrer);
    }

    // Auto-resize iframe based on content height
    const resizeIframe = () => {
      const height = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      );
      
      // Send height to parent window
      if (window.parent !== window) {
        try {
          window.parent.postMessage({
            type: 'csd-iframe-resize',
            height: height + 50
          }, '*');
        } catch (e) {
          console.log('Could not communicate with parent window');
        }
      }
    };

    // Initial resize
    setTimeout(resizeIframe, 1000);
    
    // Resize on form changes
    const observer = new MutationObserver(resizeIframe);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true
    });

    // Resize on window resize
    window.addEventListener('resize', resizeIframe);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resizeIframe);
    };
  }, []);

  const handleFormSuccess = (data: any) => {
    // Notify parent window of successful submission
    if (window.parent !== window) {
      try {
        window.parent.postMessage({
          type: 'csd-form-success',
          data: data
        }, '*');
      } catch (e) {
        console.log('Could not communicate with parent window');
      }
    }
  };

  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-2xl mx-auto p-4">
        <CsdIntakeForm 
          embedded={true} 
          onSuccess={handleFormSuccess}
          className="shadow-none border-0"
        />
        
        {/* Minimal branding for embedded version */}
        <div className="text-center mt-4 text-xs text-gray-400">
          <p>Powered by Computer Systems Depot</p>
        </div>
      </div>
    </div>
  );
}