/**
 * Dashboard Script - Complete with HTML and Styles
 * Host this on GitHub/Cloudflare Pages and reference from Webflow
 * 
 * Usage in Webflow:
 * <script src="https://api.consentbit.com/dashboardscript.js"></script>
 * 
 * This script creates all HTML and styles automatically - no Webflow elements needed!
 */

(function() {
    'use strict';
    
    const API_BASE = 'https://consentbit-dashboard-test.web-8fb.workers.dev';
    
    // Function to get Memberstack SDK
    function getMemberstackSDK() {
        if (window.$memberstackReady === true) {
            if (window.memberstack) return window.memberstack;
            if (window.$memberstack) return window.$memberstack;
            if (window.Memberstack) return window.Memberstack;
            if (window.$memberstackDom && window.$memberstackDom.memberstack) return window.$memberstackDom.memberstack;
            if (window.$memberstackDom) return window.$memberstackDom;
        }
        return window.memberstack || 
               window.$memberstack || 
               window.Memberstack ||
               (window.$memberstackDom && window.$memberstackDom.memberstack) ||
               window.$memberstackDom ||
               null;
    }
    
    // Wait for Memberstack SDK
    async function waitForSDK() {
        let attempts = 0;
        const maxAttempts = 60; // Increased to 30 seconds (60 * 500ms)
        
    
        
        while (attempts < maxAttempts) {
            const memberstack = getMemberstackSDK();
            
            // Check if SDK is ready
            if (window.$memberstackReady === true && memberstack) {
                return memberstack;
            }
            
            // Also check if SDK exists even if ready flag isn't set yet
            if (memberstack) {
                // Try to access a method to see if it's actually ready
                if (memberstack.getCurrentMember || memberstack.onReady) {
                    return memberstack;
                }
            }
            
            if (attempts % 10 === 0) {
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
            attempts++;
        }
        
        console.error('[Dashboard] ⚠️ SDK not loaded after 30 seconds');
        return null;
    }
    
    // Check if user is logged in
    async function checkMemberstackSession() {
        try {
           
            // First wait for SDK to be available
         
            const memberstack = await waitForSDK();
            
            if (!memberstack) {
               
                return null;
            }
            
            
            // Wait for SDK to be ready (with timeout)
            if (memberstack.onReady && typeof memberstack.onReady.then === 'function') {
                try {
                 
                    await Promise.race([
                        memberstack.onReady,
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
                    ]);
                } catch (error) {
                    console.warn('[Dashboard] ⚠️ SDK ready promise timeout or error:', error);
                    // Continue anyway - SDK might still work
                }
            } else {
            }
            
            // Additional wait to ensure SDK is fully initialized
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Try multiple ways to get the member
            let member = null;
            
            // Method 1: memberstack.getCurrentMember
            if (memberstack.getCurrentMember && typeof memberstack.getCurrentMember === 'function') {
                try {
                    member = await memberstack.getCurrentMember();
                    if (member) {
                        // Check both direct and nested structure
                        const hasDirectId = !!(member.id || member._id);
                        const hasNestedId = !!(member.data && (member.data.id || member.data._id));
                        const hasDirectEmail = !!(member.email || member._email);
                        const hasNestedEmail = !!(member.data && (member.data.email || member.data._email || member.data.auth?.email));
                        
                        if (member.data) {
                        }
                    }
                } catch (error) {
                    console.error('[Dashboard] ❌ Error calling getCurrentMember:', error);
                    console.error('[Dashboard] Error details:', error.message, error.stack);
                }
            } else {
            }
            
            // Method 2: window.memberstack.getCurrentMember
            if ((!member || !member.id) && window.memberstack && window.memberstack.getCurrentMember) {
                try {
                    member = await window.memberstack.getCurrentMember();
                } catch (error) {
                    console.error('[Dashboard] ❌ Error with window.memberstack:', error);
                }
            }
            
            // Method 3: $memberstackDom.memberstack.getCurrentMember
            if ((!member || !member.id) && window.$memberstackDom) {
                if (window.$memberstackDom.memberstack && window.$memberstackDom.memberstack.getCurrentMember) {
                    try {
                        member = await window.$memberstackDom.memberstack.getCurrentMember();
                    } catch (error) {
                        console.error('[Dashboard] ❌ Error with $memberstackDom.memberstack:', error);
                    }
                }
            }
            
            // Method 4: Try $memberstackDom directly
            if ((!member || !member.id) && window.$memberstackDom && typeof window.$memberstackDom.getCurrentMember === 'function') {
                try {
                    member = await window.$memberstackDom.getCurrentMember();
                } catch (error) {
                    console.error('[Dashboard] ❌ Error with $memberstackDom:', error);
                }
            }
            
            // Handle Memberstack v2 SDK response structure: {data: {...}}
            // The actual member data might be nested in a 'data' property
            let actualMember = member;
            
            // CRITICAL: Always check if member exists first
            if (!member) {
                return null;
            }
            
          
            
            if (member && member.data) {
              
                actualMember = member.data;

            } else {
            }
            
            // Check for member ID in multiple possible locations
            // Memberstack might return id, _id, or the ID might be in a different structure
            // IMPORTANT: Check actualMember first (after extraction), then fall back to member
            const memberId = actualMember?.id || 
                           actualMember?._id || 
                           actualMember?.memberId || 
                           actualMember?.member_id ||
                           member?.data?.id || 
                           member?.data?._id ||
                           member?.id || 
                           member?._id;
            const hasId = !!memberId;
            
            // Debug: Log what we found
         
           
            
            // If no ID found, check if member exists at all (maybe just having member.data means logged in)
            if (!hasId && actualMember && Object.keys(actualMember).length > 0) {
               
            }
            
            // Accept member if we have either ID OR email (some Memberstack responses might not have ID)
            // Check for email in multiple locations including auth.email
            const hasEmail = !!(actualMember?.email || 
                               actualMember?._email || 
                               actualMember?.auth?.email ||
                               actualMember?.auth?._email ||
                               member?.email || 
                               member?._email ||
                               member?.data?.auth?.email ||
                               member?.data?.auth?._email);
            
     
            
            // Accept if we have ID OR if we have actualMember with email
            // This handles cases where ID might be missing but email exists
            // CRITICAL: Also accept if actualMember exists and has either id or auth.email directly
            const hasActualMemberWithId = !!(actualMember && actualMember.id);
            const hasActualMemberWithEmail = !!(actualMember && actualMember.auth && actualMember.auth.email);
            const hasMemberDataWithId = !!(member && member.data && member.data.id);
            const hasMemberDataWithEmail = !!(member && member.data && member.data.auth && member.data.auth.email);
            
            
            // Accept member if ANY of these conditions are true:
            // 1. We found an ID anywhere
            // 2. We found an email anywhere AND actualMember exists
            // 3. actualMember exists and has id directly
            // 4. actualMember exists and has auth.email directly
            // 5. member.data exists and has id directly
            // 6. member.data exists and has auth.email directly
            const isValidMember = hasId || 
                                 (actualMember && hasEmail) || 
                                 hasActualMemberWithId ||
                                 hasActualMemberWithEmail ||
                                 hasMemberDataWithId ||
                                 hasMemberDataWithEmail;
            
            
            if (isValidMember) {
           
                // Get email from member object (try multiple possible fields and locations)
                // Email can be in multiple locations: direct property, auth.email, or nested in member.data.auth.email
                let email = actualMember?.email || 
                           actualMember?._email || 
                           actualMember?.auth?.email ||
                           actualMember?.auth?._email ||
                           member?.email || 
                           member?._email || 
                           member?.data?.auth?.email ||
                           member?.data?.auth?._email ||
                           actualMember?.Email || 
                           actualMember?.EMAIL ||
                           member?.Email || 
                           member?.EMAIL;
                
            
                // Validate and normalize email
                if (!email) {
                  
                    return null;
                }
                
                // Normalize email (lowercase, trim)
                email = email.toString().toLowerCase().trim();
                
                // Validate email format
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(email)) {
                    console.error('[Dashboard] ❌ Invalid email format:', email);
                    return null;
                }
                
                // Store normalized email and member ID in member object for later use
                // Use the original member object but add normalized data
                const returnMember = {
                    ...member,
                    id: memberId,
                    _id: memberId,
                    email: email,
                    _email: email,
                    normalizedEmail: email,
                    data: actualMember // Keep the nested data structure
                };
                
                return returnMember;
            } else {
                // Even if no ID, check if we have email - might still be logged in
                // IMPORTANT: Check auth.email here too!
                const hasEmail = !!(actualMember?.email || 
                                   actualMember?._email || 
                                   actualMember?.auth?.email ||
                                   actualMember?.auth?._email ||
                                   member?.email || 
                                   member?._email ||
                                   member?.data?.auth?.email ||
                                   member?.data?.auth?._email);
                
            
                
                if (member) {
                    if (member.data) {
                    }
                }
                
                // If we have email but no ID, still accept it (some Memberstack responses might work this way)
                if (hasEmail && actualMember) {
                    // Extract email from all possible locations including auth.email
                    let email = actualMember?.email || 
                               actualMember?._email || 
                               actualMember?.auth?.email ||
                               actualMember?.auth?._email ||
                               member?.email || 
                               member?._email ||
                               member?.data?.auth?.email ||
                               member?.data?.auth?._email;
                    email = email.toString().toLowerCase().trim();
                    
                    const returnMember = {
                        ...member,
                        id: 'no-id',
                        _id: 'no-id',
                        email: email,
                        _email: email,
                        normalizedEmail: email,
                        data: actualMember
                    };
                    
                    return returnMember;
                }
                
                return null;
            }
        } catch (error) {
            console.error('[Dashboard] Error checking session:', error);
            console.error('[Dashboard] Error details:', error.message);
            if (error.stack) {
                console.error('[Dashboard] Stack trace:', error.stack);
            }
            return null;
        }
    }
    
    // Create dashboard HTML structure with sidebar
    function createDashboardHTML() {
        // Check if dashboard already exists
        if (document.getElementById('dashboard-container')) {
            return;
        }
        
        const body = document.body;
        
        if (!body) {
            console.error('[Dashboard] ❌ Body element not found!');
            return;
        }
        
        // Create main container with flex layout
        const container = document.createElement('div');
        container.id = 'dashboard-container';
        container.style.cssText = `
            display: flex;
            min-height: 100vh;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: #f5f5f5;
        `;
        
        // Sidebar
        const sidebar = document.createElement('div');
        sidebar.id = 'dashboard-sidebar';
        sidebar.style.cssText = `
            width: 250px;
            background: #2c3e50;
            color: white;
            padding: 20px 0;
            box-shadow: 2px 0 10px rgba(0,0,0,0.1);
            position: fixed;
            height: 100vh;
            overflow-y: auto;
        `;
        
        sidebar.innerHTML = `
            <div style="padding: 20px; border-bottom: 1px solid rgba(255,255,255,0.1);">
                <h2 style="margin: 0; font-size: 20px; color: white;">📋 Dashboard</h2>
            </div>
            <nav style="padding: 10px 0;">
                <button class="sidebar-item active" data-section="domains" style="
                    width: 100%;
                    padding: 15px 20px;
                    background: transparent;
                    border: none;
                    color: white;
                    text-align: left;
                    cursor: pointer;
                    font-size: 16px;
                    transition: all 0.3s;
                    border-left: 3px solid transparent;
                ">
                    🌐 Domains/Sites
                </button>
                <button class="sidebar-item" data-section="subscriptions" style="
                    width: 100%;
                    padding: 15px 20px;
                    background: transparent;
                    border: none;
                    color: white;
                    text-align: left;
                    cursor: pointer;
                    font-size: 16px;
                    transition: all 0.3s;
                    border-left: 3px solid transparent;
                ">
                    💳 Subscriptions
                </button>
                <button class="sidebar-item" data-section="payment" style="
                    width: 100%;
                    padding: 15px 20px;
                    background: transparent;
                    border: none;
                    color: white;
                    text-align: left;
                    cursor: pointer;
                    font-size: 16px;
                    transition: all 0.3s;
                    border-left: 3px solid transparent;
                ">
                    💰 Payment
                </button>
                <button class="sidebar-item" data-section="licenses" style="
                    width: 100%;
                    padding: 15px 20px;
                    background: transparent;
                    border: none;
                    color: white;
                    text-align: left;
                    cursor: pointer;
                    font-size: 16px;
                    transition: all 0.3s;
                    border-left: 3px solid transparent;
                ">
                    🔑 License Keys
                </button>
            </nav>
            <div style="padding: 20px; border-top: 1px solid rgba(255,255,255,0.1); margin-top: auto;">
                <button id="logout-button" style="
                    width: 100%;
                    padding: 12px;
                    background: #e74c3c;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 600;
                ">Logout</button>
            </div>
        `;
        
        // Main content area
        const mainContent = document.createElement('div');
        mainContent.id = 'dashboard-main-content';
        mainContent.style.cssText = `
            flex: 1;
            margin-left: 250px;
            padding: 30px;
            background: #f5f5f5;
        `;
        
        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 25px 30px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        `;
        header.innerHTML = `
            <h1 style="margin: 0; color: #333; font-size: 28px;">License Dashboard</h1>
            <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">Manage your sites, subscriptions, and payments</p>
        `;
        
        // Error message
        const errorMessage = document.createElement('div');
        errorMessage.id = 'error-message';
        errorMessage.style.cssText = `
            background: #ffebee;
            color: #c62828;
            padding: 15px 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            display: none;
            border-left: 4px solid #c62828;
        `;
        
        // Success message
        const successMessage = document.createElement('div');
        successMessage.id = 'success-message';
        successMessage.style.cssText = `
            background: #e8f5e9;
            color: #2e7d32;
            padding: 15px 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            display: none;
            border-left: 4px solid #2e7d32;
        `;
        
        // Content sections (hidden by default, shown based on sidebar selection)
        const domainsSection = document.createElement('div');
        domainsSection.id = 'domains-section';
        domainsSection.className = 'content-section';
        domainsSection.style.cssText = 'display: block;';
        domainsSection.innerHTML = `
            <div style="background: white; border-radius: 12px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <h2 style="margin: 0 0 20px 0; color: #333; font-size: 24px;">🌐 Your Domains/Sites</h2>
                <div id="domains-table-container"></div>
            </div>
        `;
        
        const subscriptionsSection = document.createElement('div');
        subscriptionsSection.id = 'subscriptions-section';
        subscriptionsSection.className = 'content-section';
        subscriptionsSection.style.cssText = 'display: none;';
        subscriptionsSection.innerHTML = `
            <div style="background: white; border-radius: 12px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <h2 style="margin: 0 0 20px 0; color: #333; font-size: 24px;">💳 Your Subscriptions</h2>
                <div id="subscriptions-accordion-container"></div>
            </div>
        `;
        
        const paymentSection = document.createElement('div');
        paymentSection.id = 'payment-section';
        paymentSection.className = 'content-section';
        paymentSection.style.cssText = 'display: none;';
        paymentSection.innerHTML = `
            <div style="background: white; border-radius: 12px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <h2 style="margin: 0 0 20px 0; color: #333; font-size: 24px;">💰 Payment History</h2>
                <div id="payment-container">
                    <p style="color: #666;">Payment history will be displayed here.</p>
                </div>
            </div>
        `;
        
        const licensesSection = document.createElement('div');
        licensesSection.id = 'licenses-section';
        licensesSection.className = 'content-section';
        licensesSection.style.cssText = 'display: none;';
        licensesSection.innerHTML = `
            <div style="background: white; border-radius: 12px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px;">
                <h2 style="margin: 0 0 20px 0; color: #333; font-size: 24px;">🔑 Purchase License Keys</h2>
                <div id="quantity-purchase-container">
                    <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                        <p style="margin: 0 0 15px 0; color: #666;">Purchase license keys in bulk. Each quantity will create a separate subscription (one per license) for individual management. Each license key can be used for any site.</p>
                        <div style="display: flex; flex-direction: column; gap: 15px;">
                            <!-- Subscription dropdown removed for Option 2: Creating separate subscriptions -->
                            <!-- No existing subscription needed - each license gets its own new subscription -->
                            <div style="display: flex; gap: 15px; align-items: flex-end;">
                                <div style="flex: 1;">
                                    <label style="display: block; margin-bottom: 8px; color: #333; font-weight: 600;">Quantity</label>
                                    <input type="number" id="license-quantity-input" min="1" value="1" style="
                                        width: 100%;
                                        padding: 12px;
                                        border: 2px solid #e0e0e0;
                                        border-radius: 6px;
                                        font-size: 16px;
                                    ">
                                </div>
                                <button id="purchase-quantity-button" style="
                                    padding: 12px 30px;
                                    background: #667eea;
                                    color: white;
                                    border: none;
                                    border-radius: 6px;
                                    font-size: 16px;
                                    font-weight: 600;
                                    cursor: pointer;
                                    white-space: nowrap;
                                ">Purchase Now</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div style="background: white; border-radius: 12px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <h2 style="margin: 0; color: #333; font-size: 24px;">📋 Your License Keys</h2>
                    <button id="generate-missing-licenses-button" style="
                        padding: 10px 20px;
                        background: #4caf50;
                        color: white;
                        border: none;
                        border-radius: 6px;
                        font-size: 14px;
                        font-weight: 600;
                        cursor: pointer;
                        white-space: nowrap;
                    " title="Generate license keys for existing purchases">🔧 Generate Missing Licenses</button>
                </div>
                <div id="licenses-list-container">
                    <p style="color: #666;">Your license keys will be displayed here.</p>
                </div>
            </div>
        `;
        
        // Legacy containers (for backward compatibility)
        const sitesContainer = document.createElement('div');
        sitesContainer.id = 'sites-container';
        sitesContainer.style.display = 'none';
        
        const licensesContainer = document.createElement('div');
        licensesContainer.id = 'licenses-container';
        licensesContainer.style.display = 'none';
        
        // Login Prompt
        const loginPrompt = document.createElement('div');
        loginPrompt.id = 'login-prompt';
        loginPrompt.style.cssText = `
            display: none;
            text-align: center;
            padding: 100px 20px;
            max-width: 500px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        `;
        loginPrompt.innerHTML = `
            <div style="font-size: 48px; margin-bottom: 20px;">🔐</div>
            <h2 style="margin-bottom: 15px; color: #333;">Please Log In</h2>
            <p style="color: #666; margin-bottom: 30px;">You need to be logged in to view your dashboard.</p>
            <a href="/" style="
                display: inline-block;
                padding: 12px 24px;
                background: #667eea;
                color: white;
                text-decoration: none;
                border-radius: 6px;
                font-weight: 600;
            ">Go to Login Page</a>
        `;
        
        // Assemble main content
        mainContent.appendChild(header);
        mainContent.appendChild(errorMessage);
        mainContent.appendChild(successMessage);
        mainContent.appendChild(domainsSection);
        mainContent.appendChild(subscriptionsSection);
        mainContent.appendChild(paymentSection);
        mainContent.appendChild(licensesSection);
        mainContent.appendChild(sitesContainer);
        mainContent.appendChild(licensesContainer);
        mainContent.appendChild(loginPrompt);
        
        // Assemble container
        container.appendChild(sidebar);
        container.appendChild(mainContent);
        
        // Add to body
        body.appendChild(container);
        
        // Add sidebar navigation handlers
        sidebar.querySelectorAll('.sidebar-item').forEach(btn => {
            btn.addEventListener('click', function() {
                // Update active state
                sidebar.querySelectorAll('.sidebar-item').forEach(b => {
                    b.classList.remove('active');
                    b.style.background = 'transparent';
                    b.style.borderLeftColor = 'transparent';
                });
                this.classList.add('active');
                this.style.background = 'rgba(255,255,255,0.1)';
                this.style.borderLeftColor = '#3498db';
                
                // Show/hide sections
                const section = this.getAttribute('data-section');
                document.querySelectorAll('.content-section').forEach(s => {
                    s.style.display = 'none';
                });
                const targetSection = document.getElementById(`${section}-section`);
                if (targetSection) {
                    targetSection.style.display = 'block';
                }
            });
            
            // Hover effects
            btn.addEventListener('mouseenter', function() {
                if (!this.classList.contains('active')) {
                    this.style.background = 'rgba(255,255,255,0.05)';
                }
            });
            btn.addEventListener('mouseleave', function() {
                if (!this.classList.contains('active')) {
                    this.style.background = 'transparent';
                }
            });
        });
        
        // Initialize first sidebar item as active
        const firstSidebarItem = sidebar.querySelector('.sidebar-item');
        if (firstSidebarItem) {
            firstSidebarItem.style.background = 'rgba(255,255,255,0.1)';
            firstSidebarItem.style.borderLeftColor = '#3498db';
        }
        
    }
    
    // Show error message
    function showError(message) {
        const errorDiv = document.getElementById('error-message');
        if (errorDiv) {
            errorDiv.textContent = message;
            errorDiv.style.display = 'block';
            setTimeout(() => {
                errorDiv.style.display = 'none';
            }, 5000);
        }
        console.error('[Dashboard] Error:', message);
    }
    
    // Show success message
    function showSuccess(message) {
        const successDiv = document.getElementById('success-message');
        if (successDiv) {
            successDiv.textContent = message;
            successDiv.style.display = 'block';
            setTimeout(() => {
                successDiv.style.display = 'none';
            }, 3000);
        }
    }
    
    // Global variable to store current user email
    let currentUserEmail = null;
    
    // Helper function to get logged in user email (async version)
    async function getLoggedInEmail() {
        // First, try the global variable (set when dashboard loads)
        if (currentUserEmail) {
            return currentUserEmail;
        }
        
        // Try to get email from the member object if available
        if (window.currentMember && window.currentMember.email) {
            const email = window.currentMember.email.toLowerCase().trim();
            currentUserEmail = email;
            return email;
        }
        
        // Try to get from memberstack session (async)
        if (window.$memberstackDom) {
            try {
                // Check if getCurrentMember is async
                let member;
                if (typeof window.$memberstackDom.getCurrentMember === 'function') {
                    const result = window.$memberstackDom.getCurrentMember();
                    // If it returns a promise, await it
                    if (result && typeof result.then === 'function') {
                        member = await result;
                    } else {
                        member = result;
                    }
                }
                
                if (member) {
                    const email = member.data?.auth?.email || member.data?.email || member.email || member._email;
                    if (email) {
                        const normalizedEmail = email.toLowerCase().trim();
                        currentUserEmail = normalizedEmail;
                        return normalizedEmail;
                    }
                }
            } catch (e) {
                console.error('[Dashboard] Error getting email from memberstack:', e);
            }
        }
        
        // Try Memberstack SDK directly if available
        if (window.Memberstack) {
            try {
                const member = await window.Memberstack.getCurrentMember();
                if (member && (member.email || member._email)) {
                    const email = (member.email || member._email).toLowerCase().trim();
                    currentUserEmail = email;
                    return email;
                }
            } catch (e) {
                console.error('[Dashboard] Error getting email from Memberstack SDK:', e);
            }
        }
        
        // Try to get from localStorage or sessionStorage
        const storedEmail = localStorage.getItem('userEmail') || sessionStorage.getItem('userEmail');
        if (storedEmail) {
            const email = storedEmail.toLowerCase().trim();
            currentUserEmail = email;
            return email;
        }
        
        return null;
    }
    
    // Load dashboard data
    async function loadDashboard(userEmail) {
        // Try new container first, fallback to legacy
        const domainsContainer = document.getElementById('domains-table-container');
        const subscriptionsContainer = document.getElementById('subscriptions-accordion-container');
        const sitesContainer = document.getElementById('sites-container');
        
        const loadingContainer = domainsContainer || sitesContainer;
        if (!loadingContainer) {
            console.error('[Dashboard] Dashboard containers not found');
            return;
        }
        
        // Validate email before making API call
        if (!userEmail || !userEmail.includes('@')) {
            console.error('[Dashboard] ❌ Invalid email for API call:', userEmail);
            if (loadingContainer) {
                loadingContainer.innerHTML = '<div style="text-align: center; padding: 40px; color: #f44336;">Invalid email address. Please log out and log in again.</div>';
            }
            return;
        }
        
        // Show loading state
        if (domainsContainer) {
            domainsContainer.innerHTML = '<div style="text-align: center; padding: 40px; color: #666;">Loading domains...</div>';
        }
        if (subscriptionsContainer) {
            subscriptionsContainer.innerHTML = '<div style="text-align: center; padding: 40px; color: #666;">Loading subscriptions...</div>';
        }
        if (sitesContainer) {
            sitesContainer.innerHTML = '<div style="text-align: center; padding: 40px; color: #666;">Loading sites...</div>';
        }
        
        
        try {
            // Try email-based endpoint first
            let response = await fetch(`${API_BASE}/dashboard?email=${encodeURIComponent(userEmail)}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include'
            });
            
            
            // If email endpoint doesn't work, try with session cookie
            if (!response.ok && response.status === 401) {
                response = await fetch(`${API_BASE}/dashboard`, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    credentials: 'include'
                });
            }
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error('[Dashboard] ❌ API Error:', response.status, errorText);
                
                if (response.status === 401) {
                    throw new Error('Not authenticated');
                } else if (response.status === 404) {
                    throw new Error('User data not found for this email');
                }
                throw new Error(`Failed to load dashboard: ${response.status}`);
            }
            
            const data = await response.json();
            
            // Store dashboard data globally for use in other functions
            window.dashboardData = {
                sites: data.sites || {},
                subscriptions: data.subscriptions || {},
                pendingSites: data.pendingSites || []
            };
            
            // Check if sites exist but are empty
            if (data.sites && Object.keys(data.sites).length === 0) {
                console.warn('[Dashboard] ⚠️ Sites object exists but is empty!');
                console.warn('[Dashboard] ⚠️ This might mean sites were filtered out or not stored correctly');
            }
            
            // Display sites/domains
            displaySites(data.sites || {});
            
            // Display subscriptions (including pending sites)
            displaySubscriptions(data.subscriptions || {}, data.sites || {}, data.pendingSites || []);
            
            // Load license keys
            loadLicenseKeys(userEmail);
        } catch (error) {
            console.error('[Dashboard] ❌ Error loading dashboard:', error);
            console.error('[Dashboard] Error details:', error.message);
            const errorMsg = `<div style="text-align: center; padding: 40px; color: #f44336;">
                <p>Failed to load dashboard data.</p>
                <p style="font-size: 12px; margin-top: 10px;">Error: ${error.message}</p>
                <p style="font-size: 12px;">Email used: ${userEmail}</p>
                <p style="font-size: 12px;">Please refresh the page or contact support.</p>
            </div>`;
            
            if (domainsContainer) domainsContainer.innerHTML = errorMsg;
            if (subscriptionsContainer) subscriptionsContainer.innerHTML = errorMsg;
            if (sitesContainer) sitesContainer.innerHTML = errorMsg;
        }
    }
    
    // Load and display license keys
    async function loadLicenseKeys(userEmail) {
        const container = document.getElementById('licenses-list-container');
        if (!container) return;
        
        try {
            const response = await fetch(`${API_BASE}/licenses?email=${encodeURIComponent(userEmail)}`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include'
            });
            
            if (!response.ok) {
                throw new Error(`Failed to load licenses: ${response.status}`);
            }
            
            const data = await response.json();
            if (data.licenses) {
              // Log subscription cancellation details for each license
              data.licenses.forEach(license => {
                if (license.subscription_id) {
                  // Subscription details available
                }
              });
            }
            // Get subscriptions from dashboard data if available
            const dashboardData = window.dashboardData || {};
            
            // Update subscription selector with active subscriptions
            if (data.activeSubscriptions) {
                updateSubscriptionSelector(data.activeSubscriptions);
            }
            
            // Display licenses with active subscriptions from API
            displayLicenseKeys(data.licenses || [], dashboardData.subscriptions || {}, data.activeSubscriptions || []);
        } catch (error) {
            console.error('[Dashboard] Error loading license keys:', error);
            container.innerHTML = `<div style="text-align: center; padding: 40px; color: #f44336;">
                <p>Failed to load license keys.</p>
                <p style="font-size: 12px;">Error: ${error.message}</p>
            </div>`;
        }
    }
    
    // Display license keys in table
    function displayLicenseKeys(licenses, subscriptions = {}, activeSubscriptionsFromAPI = []) {
        const container = document.getElementById('licenses-list-container');
        if (!container) return;
        
        // Use activeSubscriptionsFromAPI if provided, otherwise filter from subscriptions object
        let activeSubscriptions = [];
        if (activeSubscriptionsFromAPI && activeSubscriptionsFromAPI.length > 0) {
            activeSubscriptions = activeSubscriptionsFromAPI;
        } else {
            // Fallback: filter active subscriptions from subscriptions object
            activeSubscriptions = Object.entries(subscriptions || {}).filter(([subId, sub]) => 
                sub.status === 'active' || sub.status === 'trialing'
            ).map(([subId, sub]) => ({
                subscription_id: subId,
                status: sub.status,
                billing_period: sub.billingPeriod,
                current_period_start: sub.current_period_start,
                current_period_end: sub.current_period_end
            }));
        }
        
        let html = '';
        
        // Display active subscriptions section prominently
        if (activeSubscriptions.length > 0) {
            html += `
                <div style="margin-bottom: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; color: white; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                    <h3 style="margin: 0 0 20px 0; color: white; font-size: 20px; font-weight: 600;">💳 Your Active Subscriptions</h3>
                    <p style="margin: 0 0 20px 0; color: rgba(255,255,255,0.9); font-size: 14px;">Select a subscription below to purchase additional license keys under that subscription.</p>
                    <div style="display: grid; gap: 15px;">
                        ${activeSubscriptions.map(sub => {
                            const billingPeriod = sub.billing_period ? sub.billing_period.charAt(0).toUpperCase() + sub.billing_period.slice(1) : 'N/A';
                            const subId = sub.subscription_id || 'Unknown';
                            const subIdShort = subId.length > 20 ? subId.substring(0, 20) + '...' : subId;
                            const status = sub.status || 'active';
                            const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toLocaleDateString() : 'N/A';
                            
                            return `
                                <div style="background: rgba(255,255,255,0.95); padding: 18px; border-radius: 8px; border: 2px solid rgba(255,255,255,0.3);"
                                     onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 8px rgba(0,0,0,0.15)';"
                                     onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='none';">
                                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                                        <div style="flex: 1;">
                                            <div style="font-weight: 700; color: #333; margin-bottom: 6px; font-size: 16px;">${subIdShort}</div>
                                            <div style="font-size: 13px; color: #666; display: flex; gap: 15px; flex-wrap: wrap;">
                                                <span><strong>Status:</strong> <span style="color: #4caf50; font-weight: 600;">${status.toUpperCase()}</span></span>
                                                <span><strong>Billing:</strong> <span style="font-weight: 600;">${billingPeriod}</span></span>
                                                ${periodEnd !== 'N/A' ? `<span><strong>Renews:</strong> ${periodEnd}</span>` : ''}
                                            </div>
                                        </div>
                                        <div style="
                                            padding: 8px 16px;
                                            border-radius: 20px;
                                            font-size: 12px;
                                            font-weight: 600;
                                            background: #4caf50;
                                            color: white;
                                            text-transform: uppercase;
                                        ">${status}</div>
                                    </div>
                                    <!-- Subscription selection removed for Option 2: Creating separate subscriptions -->
                                    <!-- Each license purchase creates a new subscription, so no selection needed -->
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }
        
        // Display license keys
        if (licenses.length === 0) {
            html += `
                <div style="text-align: center; padding: 60px 20px; color: #999;">
                    <div style="font-size: 48px; margin-bottom: 20px;">🔑</div>
                    <p style="font-size: 18px; margin-bottom: 10px; color: #666;">No license keys yet</p>
                    <p style="font-size: 14px; color: #999;">Purchase license keys using the form above</p>
                </div>
            `;
            container.innerHTML = html;
            return;
        }
        
        container.innerHTML = `
            <table style="width: 100%; border-collapse: collapse;">
                <thead>
                    <tr style="background: #f8f9fa; border-bottom: 2px solid #e0e0e0;">
                        <th style="padding: 15px; text-align: left; font-weight: 600; color: #333;">License Key</th>
                        <th style="padding: 15px; text-align: left; font-weight: 600; color: #333;">Status</th>
                        <th style="padding: 15px; text-align: left; font-weight: 600; color: #333;">Subscription ID</th>
                        <th style="padding: 15px; text-align: left; font-weight: 600; color: #333;">Used For Site</th>
                        <th style="padding: 15px; text-align: left; font-weight: 600; color: #333;">Purchase Type</th>
                        <th style="padding: 15px; text-align: left; font-weight: 600; color: #333;">Created</th>
                        <th style="padding: 15px; text-align: center; font-weight: 600; color: #333;">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${licenses.map(license => {
                        // For site-based purchases, use site_domain if used_site_domain is null
                        // For quantity-based purchases, use used_site_domain (which is set when activated)
                        const siteForDisplay = license.site_domain? license.site_domain : license.used_site_domain;
                         
                        const isUsed = siteForDisplay ? true : false;
                        const isQuantity = license.purchase_type === 'quantity';
                        
                        // Check if license is associated with a cancelled subscription
                        const isSubscriptionCancelled = license.subscription_cancelled || false;
                        const isLicenseInactive = license.status === 'inactive';
                        const isCancelled = isSubscriptionCancelled || isLicenseInactive;
                        
                        // Debug logging for cancelled subscriptions
                        if (license.subscription_id) {
                          // Subscription details available
                        }
                        
                        // Determine status display
                        let statusText, statusColor, statusBg;
                        if (isCancelled) {
                          if (license.subscription_cancel_at_period_end) {
                            statusText = 'CANCELLING';
                            statusColor = '#856404';
                            statusBg = '#fff3cd';
                          } else {
                            statusText = 'CANCELLED';
                            statusColor = '#721c24';
                            statusBg = '#f8d7da';
                          }
                        } else if (isUsed) {
                          statusText = 'USED';
                          statusColor = '#4caf50';
                          statusBg = '#e8f5e9';
                        } else {
                          statusText = 'AVAILABLE';
                          statusColor = '#2196f3';
                          statusBg = '#e3f2fd';
                        }
                        
                        return `
                            <tr style="border-bottom: 1px solid #e0e0e0; transition: background 0.2s;" 
                                onmouseover="this.style.background='#f8f9fa'" 
                                onmouseout="this.style.background='white'">
                                <td style="padding: 15px; font-family: monospace; font-weight: 600; color: #333;">${license.license_key}</td>
                                <td style="padding: 15px;">
                                    <span style="
                                        padding: 6px 12px;
                                        border-radius: 20px;
                                        font-size: 12px;
                                        font-weight: 600;
                                        text-transform: uppercase;
                                        background: ${statusBg};
                                        color: ${statusColor};
                                        display: inline-block;
                                    ">${statusText}</span>
                                </td>
                                <td style="padding: 15px; font-family: monospace; font-size: 12px; color: #666;">
                                    ${license.subscription_id ? `
                                        <div style="font-weight: 500; color: #333;">${license.subscription_id}</div>
                                        ${license.subscription_status ? `
                                            <div style="font-size: 10px; color: #999; margin-top: 4px;">
                                                ${license.subscription_status === 'active' ? '✓ Active' : license.subscription_status}
                                            </div>
                                        ` : ''}
                                    ` : '<span style="font-style: italic; color: #999;">N/A</span>'}
                                </td>
                                <td style="padding: 15px; color: ${isUsed ? '#4caf50' : '#999'};">
                                    <div>
                                        ${siteForDisplay || '<span style="font-style: italic;">Not assigned</span>'}
                                        ${isCancelled && siteForDisplay ? `
                                            <div style="font-size: 10px; color: #856404; margin-top: 4px;">
                                                ${license.subscription_cancel_at_period_end && license.subscription_current_period_end ? 
                                                  `Cancels: ${new Date(license.subscription_current_period_end * 1000).toLocaleDateString()}` : 
                                                  'Subscription Cancelled'}
                                            </div>
                                        ` : ''}
                                    </div>
                                </td>
                                <td style="padding: 15px; color: #666; font-size: 13px;">
                                    ${license.purchase_type === 'quantity' ? 'Quantity Purchase' : 'Site Purchase'}
                                </td>
                                <td style="padding: 15px; color: #666; font-size: 13px;">
                                    ${license.created_at ? new Date(license.created_at * 1000).toLocaleDateString() : 'N/A'}
                                </td>
                                <td style="padding: 15px; text-align: center;">
                                    <button class="copy-license-button" data-key="${license.license_key}" style="
                                        padding: 8px 16px;
                                        background: #2196f3;
                                        color: white;
                                        border: none;
                                        border-radius: 6px;
                                        cursor: pointer;
                                        font-size: 13px;
                                        font-weight: 600;
                                        margin-right: 8px;
                                    ">Copy</button>
                                    ${isQuantity ? `
                                        <button class="activate-license-button" data-key="${license.license_key}" data-current-site="${siteForDisplay || ''}" style="
                                            padding: 8px 16px;
                                            background: ${isUsed ? '#ff9800' : '#4caf50'};
                                            color: white;
                                            border: none;
                                            border-radius: 6px;
                                            cursor: pointer;
                                            font-size: 13px;
                                            font-weight: 600;
                                        ">${isUsed ? 'Update Site' : 'Activate'}</button>
                                    ` : ''}
                                    ${isQuantity && license.status === 'active' && !isUsed ? `
                                        <button class="deactivate-license-button" data-key="${license.license_key}" style="
                                            padding: 8px 16px;
                                            margin-left: 8px;
                                            background: #f44336;
                                            color: white;
                                            border: none;
                                            border-radius: 6px;
                                            cursor: pointer;
                                            font-size: 13px;
                                            font-weight: 600;
                                        ">Remove from Subscription</button>
                                    ` : ''}
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        `;
        
        // Add copy button handlers
        container.querySelectorAll('.copy-license-button').forEach(btn => {
            btn.addEventListener('click', function() {
                const key = this.getAttribute('data-key');
                navigator.clipboard.writeText(key).then(() => {
                    const originalText = this.textContent;
                    this.textContent = 'Copied!';
                    this.style.background = '#4caf50';
                    setTimeout(() => {
                        this.textContent = originalText;
                        this.style.background = '#2196f3';
                    }, 2000);
                });
            });
        });
        
        // Add activate/update license handlers
        container.querySelectorAll('.activate-license-button').forEach(btn => {
            btn.addEventListener('click', async function() {
                const key = this.getAttribute('data-key');
                const currentSite = this.getAttribute('data-current-site') || '';
                const isUpdating = currentSite !== '';
                
                const promptText = isUpdating 
                    ? `Current site: ${currentSite}\n\nEnter the new site domain for this license:`
                    : 'Enter the site domain for this license:';
                
                const siteDomain = prompt(promptText, currentSite);
                
                if (!siteDomain || !siteDomain.trim()) {
                    return;
                }
                
                const button = this;
                const originalText = button.textContent;
                button.disabled = true;
                button.textContent = isUpdating ? 'Updating...' : 'Activating...';
                
                try {
                    const response = await fetch(`${API_BASE}/activate-license`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                            license_key: key,
                            site_domain: siteDomain.trim(),
                            email: currentUserEmail
                        })
                    });
                    
                    const data = await response.json();
                    
                    if (!response.ok) {
                        // Handle specific error types with user-friendly messages
                        let errorMessage = data.message || data.error || 'Failed to activate license';
                        
                        if (data.error === 'license_not_found') {
                            errorMessage = 'License key not found. Please check the license key and try again.';
                        } else if (data.error === 'subscription_ended') {
                            errorMessage = `This license key's subscription has ended on ${data.subscription_end_date_formatted || 'the end date'}. Please renew your subscription to continue using this license.`;
                        } else if (data.error === 'subscription_cancelled') {
                            errorMessage = `This license key's subscription has been cancelled. It will end on ${data.subscription_cancel_date_formatted || 'the cancellation date'}. Please reactivate your subscription to continue using this license.`;
                        } else if (data.error === 'subscription_inactive') {
                            errorMessage = `This license key's subscription is ${data.subscription_status || 'inactive'}. Please ensure your subscription is active to use this license.`;
                        } else if (data.error === 'inactive_license') {
                            errorMessage = 'This license is not active.';
                        } else if (data.error === 'unauthorized') {
                            errorMessage = 'This license key does not belong to your account.';
                        }
                        
                        throw new Error(errorMessage);
                    }
                    
                    showSuccess(data.message || (isUpdating 
                        ? `License site updated successfully to ${siteDomain.trim()}`
                        : `License activated successfully for ${siteDomain.trim()}`));
                    
                    // Reload licenses to reflect changes
                    if (currentUserEmail) {
                        await loadLicenseKeys(currentUserEmail);
                    }
                } catch (error) {
                    console.error('[Dashboard] Error activating/updating license:', error);
                    showError('Failed to ' + (isUpdating ? 'update' : 'activate') + ' license: ' + error.message);
                    button.disabled = false;
                    button.textContent = originalText;
                }
            });
        });

        // Add deactivate (remove from subscription) handlers for quantity licenses
        container.querySelectorAll('.deactivate-license-button').forEach(btn => {
            btn.addEventListener('click', async function() {
                const key = this.getAttribute('data-key');
                
                // Check if this is an individual subscription (Use Case 3) by checking the license data
                // For Use Case 3, each license has its own subscription, so no proration
                const licenseData = licenses.find(l => l.license_key === key);
                
                // Heuristic: For quantity purchases, if the subscription_id appears only once in all licenses,
                // it's likely an individual subscription (Use Case 3 creates one subscription per license)
                let isIndividualSubscription = false;
                if (licenseData?.purchase_type === 'quantity' && licenseData?.subscription_id) {
                    const licensesWithSameSubscription = licenses.filter(l => 
                        l.subscription_id === licenseData.subscription_id
                    );
                    // If only one license has this subscription_id, it's an individual subscription
                    isIndividualSubscription = licensesWithSameSubscription.length === 1;
                }
                
                let confirmText;
                if (isIndividualSubscription) {
                    confirmText = 'Are you sure you want to cancel this license subscription?\n\n'
                        + 'This license has its own individual subscription (Use Case 3). Canceling it will cancel the entire subscription for this license. NO PRORATION applies since each license has its own subscription. The subscription will remain active until the end of the current billing period.';
                } else {
                    confirmText = 'Are you sure you want to remove this license from the subscription?\n\n'
                        + 'Stripe will prorate the current period and future invoices will be reduced for this quantity.';
                }
                
                if (!confirm(confirmText)) {
                    return;
                }

                const button = this;
                const originalText = button.textContent;
                button.disabled = true;
                button.textContent = 'Removing...';

                try {
                    const response = await fetch(`${API_BASE}/deactivate-license`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                            license_key: key,
                            email: currentUserEmail
                        })
                    });

                    const data = await response.json();

                    if (!response.ok) {
                        throw new Error(data.error || data.message || 'Failed to deactivate license');
                    }

                    // Show appropriate message based on response
                    if (data.cancel_at_period_end) {
                        // Individual subscription was canceled
                        showSuccess(data.message || 'License subscription canceled successfully. The subscription will remain active until the end of the current billing period.');
                    } else {
                        // License was removed from shared subscription (proration applies)
                        showSuccess(data.message || 'License removed from subscription successfully. Stripe will handle proration for this change.');
                    }

                    // Reload licenses and dashboard to reflect new quantity and billing
                    if (currentUserEmail) {
                        await Promise.all([
                            loadLicenseKeys(currentUserEmail),
                            loadDashboard(currentUserEmail)
                        ]);
                    }
                } catch (error) {
                    console.error('[Dashboard] Error deactivating license:', error);
                    showError('Failed to deactivate license: ' + error.message);
                    button.disabled = false;
                    button.textContent = originalText;
                }
            });
        });
    }
    
    // Update subscription selector dropdown
    function updateSubscriptionSelector(activeSubscriptions) {
        const select = document.getElementById('subscription-select');
        if (!select) return;
        
        // Clear existing options
        select.innerHTML = '';
        
        if (!activeSubscriptions || activeSubscriptions.length === 0) {
            select.innerHTML = '<option value="">No active subscriptions found</option>';
            select.disabled = true;
            return;
        }
        
        select.disabled = false;
        
        // Add default option
        select.innerHTML = '<option value="">Select a subscription...</option>';
        
        // Add subscription options
        activeSubscriptions.forEach(sub => {
            const billingPeriod = sub.billing_period ? sub.billing_period.charAt(0).toUpperCase() + sub.billing_period.slice(1) : 'N/A';
            const subIdShort = sub.subscription_id ? sub.subscription_id.substring(0, 20) + '...' : 'Unknown';
            const option = document.createElement('option');
            option.value = sub.subscription_id;
            option.textContent = `${subIdShort} - ${sub.status} (${billingPeriod})`;
            select.appendChild(option);
        });
    }
    
    // Handle quantity purchase
    // Option 2: Creating separate subscriptions (one per license) - no existing subscription needed
    async function handleQuantityPurchase(userEmail, quantity, subscriptionId = null) {
        const button = document.getElementById('purchase-quantity-button');
        const originalText = button.textContent;
        
        // No subscription selection required - we're creating NEW subscriptions
        // subscriptionId is optional and not used for Option 2
        
        try {
            button.disabled = true;
            button.textContent = 'Processing...';
            
            const response = await fetch(`${API_BASE}/purchase-quantity`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    email: userEmail,
                    quantity: parseInt(quantity)
                    // subscription_id is optional - not needed for Option 2 (separate subscriptions)
                })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || data.message || 'Purchase failed');
            }
            
            // Redirect to Stripe checkout
            if (data.checkout_url) {
                window.location.href = data.checkout_url;
            } else {
                throw new Error('No checkout URL received');
            }
        } catch (error) {
            console.error('[Dashboard] Error purchasing quantity:', error);
            showError(`Failed to process purchase: ${error.message}`);
            button.disabled = false;
            button.textContent = originalText;
        }
    }
    
    // Display sites in table format
    function displaySites(sites) {
        const container = document.getElementById('domains-table-container');
        if (!container) {
            // Fallback to legacy container
            const legacyContainer = document.getElementById('sites-container');
            if (legacyContainer) {
                container = legacyContainer;
            } else {
                return;
            }
        }
        
        if (Object.keys(sites).length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 60px 20px; color: #999;">
                    <div style="font-size: 48px; margin-bottom: 20px;">🌐</div>
                    <p style="font-size: 18px; margin-bottom: 10px; color: #666;">No domains/sites yet</p>
                    <p style="font-size: 14px; color: #999;">Add your first site from the Subscriptions section</p>
                </div>
            `;
            return;
        }
        
        // Create table
        container.innerHTML = `
            <table style="width: 100%; border-collapse: collapse;">
                <thead>
                    <tr style="background: #f8f9fa; border-bottom: 2px solid #e0e0e0;">
                        <th style="padding: 15px; text-align: left; font-weight: 600; color: #333;">Domain/Site</th>
                        <th style="padding: 15px; text-align: left; font-weight: 600; color: #333;">Status</th>
                        <th style="padding: 15px; text-align: left; font-weight: 600; color: #333;">Expiration Date</th>
                        <th style="padding: 15px; text-align: left; font-weight: 600; color: #333;">Item ID</th>
                        <th style="padding: 15px; text-align: left; font-weight: 600; color: #333;">Created</th>
                        <th style="padding: 15px; text-align: center; font-weight: 600; color: #333;">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${Object.keys(sites).map(site => {
                        const siteData = sites[site];
                        const isActive = siteData.status === 'active';
                        const statusColor = isActive ? '#4caf50' : '#f44336';
                        const statusBg = isActive ? '#e8f5e9' : '#ffebee';
                        
                        // Get expiration date (renewal_date or current_period_end)
                        const renewalDate = siteData.renewal_date || siteData.current_period_end;
                        const renewalDateStr = renewalDate ? new Date(renewalDate * 1000).toLocaleDateString() : 'N/A';
                        const isExpired = renewalDate && renewalDate < Math.floor(Date.now() / 1000);
                        const isInactiveButNotExpired = !isActive && renewalDate && !isExpired;
                        
                        return `
                            <tr style="border-bottom: 1px solid #e0e0e0; transition: background 0.2s;" 
                                onmouseover="this.style.background='#f8f9fa'" 
                                onmouseout="this.style.background='white'">
                                <td style="padding: 15px; font-weight: 500; color: #333;">${site}</td>
                                <td style="padding: 15px;">
                                    <span style="
                                        padding: 6px 12px;
                                        border-radius: 20px;
                                        font-size: 12px;
                                        font-weight: 600;
                                        text-transform: uppercase;
                                        background: ${statusBg};
                                        color: ${statusColor};
                                        display: inline-block;
                                    ">${siteData.status || 'active'}</span>
                                </td>
                                <td style="padding: 15px; font-size: 12px; color: ${isExpired ? '#f44336' : isInactiveButNotExpired ? '#f44336' : '#666'};">
                                    ${renewalDateStr}
                                    ${isExpired ? ' <span style="color: #f44336; font-size: 11px;">(Expired)</span>' : ''}
                                    ${isInactiveButNotExpired ? ' <span style="color: #f44336; font-size: 11px;">(Unsubscribed)</span>' : ''}
                                </td>
                                <td style="padding: 15px; color: #666; font-size: 13px; font-family: monospace;">
                                    ${siteData.item_id ? siteData.item_id.substring(0, 20) + '...' : 'N/A'}
                                </td>
                                <td style="padding: 15px; color: #666; font-size: 13px;">
                                    ${siteData.created_at ? new Date(siteData.created_at * 1000).toLocaleDateString() : 'N/A'}
                                </td>
                                <td style="padding: 15px; text-align: center;">
                                    ${isActive ? `
                                        <button class="remove-site-button" data-site="${site}" data-subscription-id="${siteData.subscription_id || ''}" style="
                                            padding: 8px 16px;
                                            background: #f44336;
                                            color: white;
                                            border: none;
                                            border-radius: 6px;
                                            cursor: pointer;
                                            font-size: 13px;
                                            font-weight: 600;
                                            transition: all 0.3s;
                                        " onmouseover="this.style.background='#d32f2f'; this.style.transform='scale(1.05)'" 
                                           onmouseout="this.style.background='#f44336'; this.style.transform='scale(1)'">
                                            Unsubscribe
                                        </button>
                                    ` : '<span style="color: #999; font-size: 12px;">Unsubscribed</span>'}
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        `;
        
        // Attach event listeners to remove buttons
        container.querySelectorAll('.remove-site-button').forEach(btn => {
            btn.addEventListener('click', () => {
                const site = btn.getAttribute('data-site');
                const subscriptionId = btn.getAttribute('data-subscription-id');
                removeSite(site, subscriptionId);
            });
        });
    }
    
    // Display subscriptions in accordion format
    function displaySubscriptions(subscriptions, allSites, pendingSites = []) {
        const container = document.getElementById('subscriptions-accordion-container');
        if (!container) return;
        
        if (Object.keys(subscriptions).length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 60px 20px; color: #999;">
                    <div style="font-size: 48px; margin-bottom: 20px;">💳</div>
                    <p style="font-size: 18px; margin-bottom: 10px; color: #666;">No subscriptions yet</p>
                    <p style="font-size: 14px; color: #999;">Create a subscription to get started</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = Object.keys(subscriptions).map((subId, index) => {
            const sub = subscriptions[subId];
            const isExpanded = index === 0; // First subscription expanded by default
            
            // Get billing period from subscription data (fetched from Stripe)
            const billingPeriod = sub.billingPeriod || null;
            
            // Get sites for this subscription
            const subscriptionSites = Object.keys(allSites).filter(site => 
                allSites[site].subscription_id === subId
            );
            
            return `
                <div class="subscription-accordion" data-subscription-id="${subId}" style="
                    border: 1px solid #e0e0e0;
                    border-radius: 8px;
                    margin-bottom: 15px;
                    overflow: hidden;
                    background: white;
                ">
                    <div class="subscription-header" style="
                        padding: 20px;
                        background: ${isExpanded ? '#f8f9fa' : 'white'};
                        cursor: pointer;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        transition: background 0.3s;
                    " onmouseover="this.style.background='#f0f0f0'" onmouseout="this.style.background='${isExpanded ? '#f8f9fa' : 'white'}'">
                        <div style="flex: 1;">
                            <div style="display: flex; align-items: center; gap: 15px; margin-bottom: 8px;">
                                <h3 style="margin: 0; color: #333; font-size: 18px;">Subscription ${index + 1}</h3>
                                <span style="
                                    padding: 4px 12px;
                                    border-radius: 20px;
                                    font-size: 11px;
                                    font-weight: 600;
                                    text-transform: uppercase;
                                    background: ${sub.status === 'active' ? '#e8f5e9' : sub.status === 'cancelling' ? '#fff3cd' : sub.status === 'deleted' ? '#f8d7da' : '#ffebee'};
                                    color: ${sub.status === 'active' ? '#4caf50' : sub.status === 'cancelling' ? '#856404' : sub.status === 'deleted' ? '#721c24' : '#f44336'};
                                ">${sub.status === 'cancelling' ? 'Cancelling' : sub.status === 'deleted' ? 'Deleted' : (sub.status || 'active')}</span>
                                ${sub.cancel_at_period_end ? `
                                    <span style="
                                        padding: 4px 12px;
                                        border-radius: 20px;
                                        font-size: 11px;
                                        font-weight: 600;
                                        background: #fff3cd;
                                        color: #856404;
                                    ">Ends: ${sub.current_period_end ? new Date(sub.current_period_end * 1000).toLocaleDateString() : 'N/A'}</span>
                                ` : ''}
                                <span style="
                                    padding: 4px 12px;
                                    border-radius: 20px;
                                    font-size: 11px;
                                    font-weight: 600;
                                    background: #e3f2fd;
                                    color: #1976d2;
                                ">${billingPeriod ? billingPeriod.charAt(0).toUpperCase() + billingPeriod.slice(1) : 'N/A'}</span>
                            </div>
                            <div style="font-size: 13px; color: #666;">
                                <div>Customer ID: <code style="background: #f5f5f5; padding: 2px 6px; border-radius: 4px; font-size: 12px;">${sub.customerId || 'N/A'}</code></div>
                                <div style="margin-top: 5px;">Subscription ID: <code style="background: #f5f5f5; padding: 2px 6px; border-radius: 4px; font-size: 12px;">${subId.substring(0, 20)}...</code></div>
                                <div style="margin-top: 5px;">Sites: ${sub.sitesCount || subscriptionSites.length}</div>
                            </div>
                        </div>
                        <div style="
                            font-size: 24px;
                            color: #666;
                            transition: transform 0.3s;
                            transform: ${isExpanded ? 'rotate(180deg)' : 'rotate(0deg)'};
                        ">▼</div>
                    </div>
                    <div class="subscription-content" style="
                        display: ${isExpanded ? 'block' : 'none'};
                        padding: 0;
                        border-top: 1px solid #e0e0e0;
                    ">
                        <div style="padding: 20px;">
                            ${(() => {
                                // Check if this subscription has quantity purchases (license keys instead of sites)
                                const subscriptionItems = sub.items || [];
                                const hasQuantityPurchases = subscriptionItems.some(item => item.purchase_type === 'quantity' || item.license_key);
                                
                                if (hasQuantityPurchases) {
                                    // Display license keys for quantity purchases
                                    const quantityItems = subscriptionItems.filter(item => item.purchase_type === 'quantity' || item.license_key);
                                    return `
                                        <h4 style="margin: 0 0 15px 0; color: #333; font-size: 16px;">License Keys in this subscription:</h4>
                                        <div id="subscription-licenses-${subId}" style="margin-bottom: 20px;">
                                            ${quantityItems.length > 0 ? `
                                                <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                                                    <thead>
                                                        <tr style="background: #f8f9fa; border-bottom: 1px solid #e0e0e0;">
                                                            <th style="padding: 10px; text-align: left; font-size: 12px; color: #666;">License Key</th>
                                                            <th style="padding: 10px; text-align: left; font-size: 12px; color: #666;">Status</th>
                                                            <th style="padding: 10px; text-align: left; font-size: 12px; color: #666;">Item ID</th>
                                                            <th style="padding: 10px; text-align: left; font-size: 12px; color: #666;">Created</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        ${quantityItems.map(item => {
                                                            const statusColor = item.status === 'active' ? '#4caf50' : '#f44336';
                                                            const statusBg = item.status === 'active' ? '#e8f5e9' : '#ffebee';
                                                            const createdDate = item.created_at ? new Date(item.created_at * 1000).toLocaleDateString() : 'N/A';
                                                            
                                                            return `
                                                                <tr style="border-bottom: 1px solid #f0f0f0;">
                                                                    <td style="padding: 10px; font-size: 13px; font-family: monospace; font-weight: 600; color: #333;">
                                                                        ${item.license_key || 'N/A'}
                                                                    </td>
                                                                    <td style="padding: 10px;">
                                                                        <span style="
                                                                            padding: 4px 8px;
                                                                            border-radius: 12px;
                                                                            font-size: 11px;
                                                                            font-weight: 600;
                                                                            background: ${statusBg};
                                                                            color: ${statusColor};
                                                                        ">${item.status || 'active'}</span>
                                                                    </td>
                                                                    <td style="padding: 10px; font-size: 12px; font-family: monospace; color: #666;">
                                                                        ${item.item_id ? item.item_id.substring(0, 20) + '...' : 'N/A'}
                                                                    </td>
                                                                    <td style="padding: 10px; font-size: 12px; color: #666;">
                                                                        ${createdDate}
                                                                    </td>
                                                                </tr>
                                                            `;
                                                        }).join('')}
                                                    </tbody>
                                                </table>
                                            ` : '<p style="color: #999; font-size: 14px; margin-bottom: 20px;">No license keys in this subscription yet.</p>'}
                                        </div>
                                    `;
                                } else {
                                    // Display sites for site purchases (existing logic)
                                    return `
                                        <h4 style="margin: 0 0 15px 0; color: #333; font-size: 16px;">Sites in this subscription:</h4>
                                        <div id="subscription-sites-${subId}" style="margin-bottom: 20px;">
                                            ${subscriptionSites.length > 0 ? `
                                                <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                                                    <thead>
                                                        <tr style="background: #f8f9fa; border-bottom: 1px solid #e0e0e0;">
                                                            <th style="padding: 10px; text-align: left; font-size: 12px; color: #666;">Site</th>
                                                            <th style="padding: 10px; text-align: left; font-size: 12px; color: #666;">Status</th>
                                                            <th style="padding: 10px; text-align: left; font-size: 12px; color: #666;">Renewal Date</th>
                                                            <th style="padding: 10px; text-align: left; font-size: 12px; color: #666;">Amount Paid</th>
                                                            <th style="padding: 10px; text-align: left; font-size: 12px; color: #666;">License</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        ${subscriptionSites.map(site => {
                                                            const siteData = allSites[site];
                                                            const license = siteData.license;
                                                            const renewalDate = siteData.renewal_date || siteData.current_period_end;
                                                            const renewalDateStr = renewalDate ? new Date(renewalDate * 1000).toLocaleDateString() : 'N/A';
                                                            const isExpired = renewalDate && renewalDate < Math.floor(Date.now() / 1000);
                                                            const isInactive = siteData.status === 'inactive';
                                                            const isInactiveButNotExpired = isInactive && renewalDate && !isExpired;
                                                            const statusDisplay = siteData.status === 'cancelling' ? 'Cancelling' : 
                                                                                  siteData.status === 'expired' ? 'Expired' : 
                                                                                  siteData.status === 'inactive' ? 'Inactive' : 
                                                                                  siteData.status || 'Active';
                                                            const statusColor = siteData.status === 'active' ? '#4caf50' : 
                                                                                siteData.status === 'cancelling' ? '#856404' : 
                                                                                siteData.status === 'expired' ? '#721c24' : '#f44336';
                                                            const statusBg = siteData.status === 'active' ? '#e8f5e9' : 
                                                                              siteData.status === 'cancelling' ? '#fff3cd' : 
                                                                              siteData.status === 'expired' ? '#f8d7da' : '#ffebee';
                                                            
                                                            return `
                                                                <tr style="border-bottom: 1px solid #f0f0f0;">
                                                                    <td style="padding: 10px; font-size: 13px; font-weight: 500;">${site}</td>
                                                                    <td style="padding: 10px;">
                                                                        <span style="
                                                                            padding: 4px 8px;
                                                                            border-radius: 12px;
                                                                            font-size: 11px;
                                                                            font-weight: 600;
                                                                            background: ${statusBg};
                                                                            color: ${statusColor};
                                                                        ">${statusDisplay}</span>
                                                                        ${siteData.cancel_at_period_end && !isExpired ? `
                                                                            <div style="font-size: 10px; color: #856404; margin-top: 4px;">
                                                                                Cancels: ${renewalDateStr}
                                                                            </div>
                                                                        ` : ''}
                                                                    </td>
                                                                    <td style="padding: 10px; font-size: 12px; color: ${isExpired ? '#f44336' : isInactiveButNotExpired ? '#f44336' : '#666'};">
                                                                        ${renewalDateStr}
                                                                        ${isExpired ? ' <span style="color: #f44336;">(Expired)</span>' : ''}
                                                                        ${isInactiveButNotExpired ? ' <span style="color: #f44336; font-size: 11px;">(Unsubscribed)</span>' : ''}
                                                                    </td>
                                                                    <td style="padding: 10px; font-size: 12px; color: #666;">
                                                                        ${siteData.amount_paid ? `$${(siteData.amount_paid / 100).toFixed(2)}` : 'N/A'}
                                                                    </td>
                                                                    <td style="padding: 10px; font-size: 12px; font-family: monospace; color: #666;">
                                                                        ${license ? license.license_key.substring(0, 20) + '...' : 'N/A'}
                                                                    </td>
                                                                </tr>
                                                            `;
                                                        }).join('')}
                                                    </tbody>
                                                </table>
                                            ` : '<p style="color: #999; font-size: 14px; margin-bottom: 20px;">No sites in this subscription yet.</p>'}
                                        </div>
                                    `;
                                }
                            })()}
                            
                            <div style="padding: 20px; background: #f8f9fa; border-radius: 8px; margin-top: 20px;">
                                <h4 style="margin: 0 0 15px 0; color: #333; font-size: 16px;">Add Sites to This Subscription</h4>
                                
                                <!-- Pending Sites List -->
                                <div id="pending-sites-${subId}" style="margin-bottom: 20px;">
                                    <!-- Pending sites will be dynamically added here -->
                                </div>
                                
                                <!-- Add Site Input -->
                                <div style="display: flex; gap: 10px; margin-bottom: 15px; flex-wrap: wrap;">
                                    <input 
                                        type="text" 
                                        id="new-site-input-${subId}" 
                                        placeholder="Enter site domain (e.g., example.com)"
                                        style="
                                            flex: 1;
                                            min-width: 250px;
                                            padding: 12px;
                                            border: 2px solid #e0e0e0;
                                            border-radius: 6px;
                                            font-size: 14px;
                                        "
                                    />
                                    <button class="add-to-pending" data-subscription-id="${subId}" style="
                                        padding: 12px 24px;
                                        background: #667eea;
                                        color: white;
                                        border: none;
                                        border-radius: 6px;
                                        font-size: 14px;
                                        font-weight: 600;
                                        cursor: pointer;
                                        transition: background 0.3s;
                                    " onmouseover="this.style.background='#5568d3'" onmouseout="this.style.background='#667eea'">
                                        Add to List
                                    </button>
                                </div>
                                
                                <p style="font-size: 12px; color: #666; margin: 10px 0 0 0;">
                                    💡 Add multiple sites, then click "Pay Now" to checkout. Price will be automatically determined.
                                </p>
                                
                                <!-- Pay Now Button (hidden until at least one site is added) -->
                                <div id="pay-now-container-${subId}" style="display: none; margin-top: 20px; padding-top: 20px; border-top: 2px solid #e0e0e0;">
                                    <button class="pay-now-button" data-subscription-id="${subId}" style="
                                        width: 100%;
                                        padding: 14px 28px;
                                        background: #4caf50;
                                        color: white;
                                        border: none;
                                        border-radius: 6px;
                                        font-size: 16px;
                                        font-weight: 600;
                                        cursor: pointer;
                                        transition: background 0.3s;
                                    " onmouseover="this.style.background='#45a049'" onmouseout="this.style.background='#4caf50'">
                                        💳 Pay Now (<span id="pending-count-${subId}">0</span> site<span id="pending-plural-${subId}">s</span>)
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        
        // Add accordion toggle functionality
        container.querySelectorAll('.subscription-header').forEach(header => {
            header.addEventListener('click', function() {
                const accordion = this.closest('.subscription-accordion');
                const content = accordion.querySelector('.subscription-content');
                const arrow = this.querySelector('div:last-child');
                const isExpanded = content.style.display !== 'none';
                
                // Close all other accordions
                container.querySelectorAll('.subscription-content').forEach(c => {
                    if (c !== content) {
                        c.style.display = 'none';
                        c.previousElementSibling.style.background = 'white';
                        c.previousElementSibling.querySelector('div:last-child').style.transform = 'rotate(0deg)';
                    }
                });
                
                // Toggle current accordion
                if (isExpanded) {
                    content.style.display = 'none';
                    this.style.background = 'white';
                    arrow.style.transform = 'rotate(0deg)';
                } else {
                    content.style.display = 'block';
                    this.style.background = '#f8f9fa';
                    arrow.style.transform = 'rotate(180deg)';
                }
            });
        });
        
        // Initialize pending sites storage for each subscription
        // Load pending sites from backend response
        const pendingSitesBySubscription = {};
        const subscriptionIds = Object.keys(subscriptions);
        const firstSubscriptionId = subscriptionIds.length > 0 ? subscriptionIds[0] : null;
        
        // Initialize all subscriptions with empty arrays
        subscriptionIds.forEach(subId => {
            pendingSitesBySubscription[subId] = [];
        });
        
        // CRITICAL: Deduplicate pending sites before distributing (case-insensitive)
        // This prevents duplicate sites from appearing in the UI
        const seenSites = new Set();
        const uniquePendingSites = [];
        
        pendingSites.forEach(ps => {
            const siteName = ps.site || ps; // Extract site name
            const siteKey = (siteName || '').toLowerCase().trim();
            
            if (!siteKey) {
                console.warn('[Dashboard] ⚠️ Skipping pending site with empty name:', ps);
                return;
            }
            
            if (!seenSites.has(siteKey)) {
                seenSites.add(siteKey);
                uniquePendingSites.push(ps);
            } else {
                console.warn(`[Dashboard] ⚠️ Skipping duplicate pending site: "${siteName}"`);
            }
        });
        
        if (pendingSites.length !== uniquePendingSites.length) {
            console.warn(`[Dashboard] ⚠️ Deduplicated ${pendingSites.length} pending sites to ${uniquePendingSites.length} unique sites`);
        }
        
        // Distribute UNIQUE pending sites to subscriptions
        uniquePendingSites.forEach(ps => {
            const siteName = ps.site || ps; // Extract site name
            const psSubscriptionId = ps.subscription_id;
            
            if (psSubscriptionId && pendingSitesBySubscription.hasOwnProperty(psSubscriptionId)) {
                // Check if site already exists in this subscription's pending list (case-insensitive)
                const existingSites = pendingSitesBySubscription[psSubscriptionId].map(s => (s || '').toLowerCase().trim());
                const siteKey = (siteName || '').toLowerCase().trim();
                
                if (!existingSites.includes(siteKey)) {
                    // Assign to matching subscription
                    pendingSitesBySubscription[psSubscriptionId].push(siteName);
                } else {
                    console.warn(`[Dashboard] ⚠️ Skipping duplicate site "${siteName}" in subscription ${psSubscriptionId}`);
                }
            } else if (firstSubscriptionId) {
                // Check if site already exists in first subscription's pending list (case-insensitive)
                const existingSites = pendingSitesBySubscription[firstSubscriptionId].map(s => (s || '').toLowerCase().trim());
                const siteKey = (siteName || '').toLowerCase().trim();
                
                if (!existingSites.includes(siteKey)) {
                    // Assign to first subscription if no subscription_id or subscription not found
                    pendingSitesBySubscription[firstSubscriptionId].push(siteName);
                } else {
                    console.warn(`[Dashboard] ⚠️ Skipping duplicate site "${siteName}" in first subscription`);
                }
            }
        });
        
        
        // Function to update pending sites display
        function updatePendingSitesDisplay(subscriptionId) {
            const pendingContainer = document.getElementById(`pending-sites-${subscriptionId}`);
            const payNowContainer = document.getElementById(`pay-now-container-${subscriptionId}`);
            const pendingCount = document.getElementById(`pending-count-${subscriptionId}`);
            const pendingPlural = document.getElementById(`pending-plural-${subscriptionId}`);
            
            if (!pendingContainer) {
                console.warn('[Dashboard] Pending container not found for subscription:', subscriptionId);
                return;
            }
            
            const pendingSites = pendingSitesBySubscription[subscriptionId] || [];
            
            if (pendingSites.length === 0) {
                pendingContainer.innerHTML = '';
                if (payNowContainer) payNowContainer.style.display = 'none';
            } else {
                pendingContainer.innerHTML = `
                    <div style="margin-bottom: 15px;">
                        <h5 style="margin: 0 0 10px 0; color: #666; font-size: 14px; font-weight: 600;">Pending Sites (${pendingSites.length}):</h5>
                        <div style="display: flex; flex-direction: column; gap: 8px;">
                            ${pendingSites.map((site, idx) => `
                                <div style="
                                    display: flex;
                                    align-items: center;
                                    justify-content: space-between;
                                    padding: 10px 15px;
                                    background: white;
                                    border: 1px solid #e0e0e0;
                                    border-radius: 6px;
                                ">
                                    <span style="font-size: 14px; color: #333;">${site}</span>
                                    <button 
                                        class="remove-pending-site" 
                                        data-subscription-id="${subscriptionId}" 
                                        data-site-index="${idx}"
                                        style="
                                            padding: 6px 12px;
                                            background: #f44336;
                                            color: white;
                                            border: none;
                                            border-radius: 4px;
                                            font-size: 12px;
                                            font-weight: 600;
                                            cursor: pointer;
                                            transition: background 0.3s;
                                        " 
                                        onmouseover="this.style.background='#d32f2f'" 
                                        onmouseout="this.style.background='#f44336'">
                                        Remove
                                    </button>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
                
                if (payNowContainer) {
                    payNowContainer.style.display = 'block';
                    if (pendingCount) pendingCount.textContent = pendingSites.length;
                    if (pendingPlural) pendingPlural.textContent = pendingSites.length === 1 ? '' : 's';
                }
            }
        }
        
        // Add event listeners for "Add to List" buttons (adds to pending list)
        container.querySelectorAll('.add-to-pending').forEach(btn => {
            btn.addEventListener('click', function() {
                const subscriptionId = this.getAttribute('data-subscription-id');
                const siteInput = document.getElementById(`new-site-input-${subscriptionId}`);
                
                if (!siteInput) {
                    console.error('[Dashboard] Site input not found for subscription:', subscriptionId);
                    return;
                }
                
                const site = siteInput.value.trim();
                
                if (!site) {
                    showError('Please enter a site domain');
                    return;
                }
                
                // Initialize if not exists
                if (!pendingSitesBySubscription[subscriptionId]) {
                    pendingSitesBySubscription[subscriptionId] = [];
                }
                
                // Check if site already in pending list (case-insensitive)
                const pendingSites = pendingSitesBySubscription[subscriptionId];
                const siteKey = (site || '').toLowerCase().trim();
                const existingSites = pendingSites.map(s => (s || '').toLowerCase().trim());
                
                if (existingSites.includes(siteKey)) {
                    showError('This site is already in the pending list');
                    return;
                }
                
                // Add to pending list (local)
                pendingSites.push(site);
                pendingSitesBySubscription[subscriptionId] = pendingSites;
                
                
                // Clear input (keep the same input field, no need to clone)
                siteInput.value = '';
                
                // Update display IMMEDIATELY (before any backend call)
                updatePendingSitesDisplay(subscriptionId);
                
                // Verify display was updated
                const pendingContainer = document.getElementById(`pending-sites-${subscriptionId}`);
                if (pendingContainer) {
                } else {
                    console.error('[Dashboard] ❌ Pending container not found after update!');
                }
                
                // CRITICAL: Save to backend immediately so sites persist if page is refreshed
                // This ensures sites are stored in database, not just in browser memory
                (async () => {
                    try {
                        const userEmail = await getLoggedInEmail();
                        if (!userEmail) {
                            console.warn('[Dashboard] ⚠️ Cannot save site to backend - no user email available');
                            showSuccess(`Site "${site}" added to pending list (not saved - will be lost on refresh)`);
                            return;
                        }
                        
                        const saveResponse = await fetch(`${API_BASE}/add-sites-batch`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            credentials: 'include',
                            body: JSON.stringify({ 
                                sites: [site], // Save single site
                                email: userEmail,
                                subscriptionId: subscriptionId
                            })
                        });
                        
                        const saveData = await saveResponse.json();
                        
                        if (saveResponse.ok) {
                            showSuccess(`Site "${site}" added to pending list`);
                        } else {
                            console.error('[Dashboard] ❌ Failed to save site to backend:', saveData);
                            showSuccess(`Site "${site}" added to pending list (save to backend failed - will be lost on refresh)`);
                        }
                    } catch (error) {
                        console.error('[Dashboard] ❌ Error saving site to backend:', error);
                        showSuccess(`Site "${site}" added to pending list (save error - will be lost on refresh)`);
                    }
                })();
            });
        });
        
        // Add event listeners for remove pending site buttons
        container.addEventListener('click', async function(e) {
            if (e.target.classList.contains('remove-pending-site')) {
                const subscriptionId = e.target.getAttribute('data-subscription-id');
                const siteIndex = parseInt(e.target.getAttribute('data-site-index'));
                const pendingSites = pendingSitesBySubscription[subscriptionId] || [];
                
                if (siteIndex >= 0 && siteIndex < pendingSites.length) {
                    const removedSiteObj = pendingSites[siteIndex];
                    // Extract site name - could be string or object with 'site' property
                    const removedSiteName = typeof removedSiteObj === 'string' 
                        ? removedSiteObj 
                        : (removedSiteObj.site || removedSiteObj.site_domain || removedSiteObj);
                    
                    // Remove from local array immediately for instant UI feedback
                    pendingSites.splice(siteIndex, 1);
                    pendingSitesBySubscription[subscriptionId] = pendingSites;
                    updatePendingSitesDisplay(subscriptionId);
                    
                    // Call backend to persist the removal
                    try {
                        const userEmail = await getLoggedInEmail();
                        if (!userEmail) {
                            console.error('[Dashboard] No user email available for removing pending site');
                            showError('Unable to get user email. Please refresh the page and try again.');
                            // Revert local change on error
                            pendingSites.splice(siteIndex, 0, removedSiteObj);
                            pendingSitesBySubscription[subscriptionId] = pendingSites;
                            updatePendingSitesDisplay(subscriptionId);
                            return;
                        }
                        
                        
                        const response = await fetch(`${API_BASE}/remove-pending-site`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            credentials: 'include',
                            body: JSON.stringify({
                                email: userEmail,
                                site: removedSiteName,
                                subscriptionId: subscriptionId
                            })
                        });
                        
                        if (response.ok) {
                            const result = await response.json();
                            showSuccess(`Site "${removedSiteName}" removed from pending list`);
                            
                            // Refresh dashboard data to ensure sync
                            await loadDashboard(userEmail);
                        } else {
                            const error = await response.text();
                            console.error('[Dashboard] ❌ Failed to remove pending site:', error);
                            showError(`Failed to remove site: ${error}`);
                            
                            // Revert local change on error
                            pendingSites.splice(siteIndex, 0, removedSiteObj);
                            pendingSitesBySubscription[subscriptionId] = pendingSites;
                            updatePendingSitesDisplay(subscriptionId);
                        }
                    } catch (error) {
                        console.error('[Dashboard] ❌ Error removing pending site:', error);
                        showError(`Error removing site: ${error.message}`);
                        
                        // Revert local change on error
                        pendingSites.splice(siteIndex, 0, removedSiteObj);
                        pendingSitesBySubscription[subscriptionId] = pendingSites;
                        updatePendingSitesDisplay(subscriptionId);
                    }
                }
            }
        });
        
        // Add event listeners for "Pay Now" buttons
        container.querySelectorAll('.pay-now-button').forEach(btn => {
            btn.addEventListener('click', async function() {
                const subscriptionId = this.getAttribute('data-subscription-id');
                const pendingSites = pendingSitesBySubscription[subscriptionId] || [];
                
                if (pendingSites.length === 0) {
                    showError('No sites to add. Please add at least one site.');
                    return;
                }
                
                const member = await checkMemberstackSession();
                if (!member) {
                    showError('Not authenticated');
                    return;
                }
                
                const userEmail = member.email || member._email;
                
                // Disable button during processing
                this.disabled = true;
                this.textContent = 'Processing...';
                
                try {
                    // Step 1: First save pending sites to backend
                    const saveResponse = await fetch(`${API_BASE}/add-sites-batch`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        credentials: 'include',
                        body: JSON.stringify({ 
                            sites: pendingSites,
                            email: userEmail
                            // No subscriptionId needed - Use Case 2 creates separate subscriptions
                        })
                    });
                    
                    const saveData = await saveResponse.json();
                    
                    if (!saveResponse.ok) {
                        throw new Error(saveData.error || saveData.message || 'Failed to save pending sites');
                    }
                    
                    
                    // Step 2: Create checkout session from pending sites (Use Case 2 - separate subscriptions)
                    const checkoutResponse = await fetch(`${API_BASE}/create-checkout-from-pending`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        credentials: 'include',
                        body: JSON.stringify({ 
                            email: userEmail
                            // No subscriptionId needed - Use Case 2 creates separate subscriptions for each site
                        })
                    });
                    
                    const checkoutData = await checkoutResponse.json();
                    
                    if (!checkoutResponse.ok) {
                        throw new Error(checkoutData.error || checkoutData.message || 'Failed to create checkout session');
                    }
                    
                    
                    // Step 3: Redirect to Stripe checkout
                    if (checkoutData.url) {
                        window.location.href = checkoutData.url;
                    } else {
                        throw new Error('No checkout URL received from server');
                    }
                } catch (error) {
                    console.error('[Dashboard] Error processing payment:', error);
                    showError('Failed to process payment: ' + error.message);
                    this.disabled = false;
                    this.textContent = `💳 Pay Now (${pendingSites.length} site${pendingSites.length === 1 ? '' : 's'})`;
                }
            });
        });
        
        // Initialize pending sites display for all subscriptions
        Object.keys(subscriptions).forEach(subId => {
            updatePendingSitesDisplay(subId);
        });
    }
    
    // Add a new site
    async function addSite(userEmail) {
        const siteInput = document.getElementById('new-site-input');
        
        if (!siteInput) {
            showError('Form element not found');
            return;
        }
        
        const site = siteInput.value.trim();
        
        if (!site) {
            showError('Please enter a site domain');
            return;
        }
        
        try {
            const response = await fetch(`${API_BASE}/add-site`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include',
                body: JSON.stringify({ 
                    site,
                    email: userEmail 
                })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || data.message || 'Failed to add site');
            }
            
            showSuccess(data.message || 'Site added successfully! Billing will be updated on next invoice.');
            siteInput.value = '';
            loadDashboard(userEmail);
        } catch (error) {
            console.error('[Dashboard] Error adding site:', error);
            showError('Failed to add site: ' + error.message);
        }
    }
    
    // Unsubscribe a site (removes from Stripe subscription and updates database)
    async function removeSite(site, subscriptionId) {
        // First, we'll show a generic confirmation, then use the backend response for the actual message
        // The backend will tell us if it's an individual subscription (no proration) or shared (proration)
        if (!confirm(`Are you sure you want to unsubscribe ${site}? The subscription will be canceled.`)) {
            return;
        }
        
        const member = await checkMemberstackSession();
        if (!member) {
            showError('Not authenticated. Please log in to continue.');
            return;
        }
        
        // Extract email from member object (handles various Memberstack response structures)
        const userEmail = member.email || 
                         member._email || 
                         member.data?.email || 
                         member.data?._email ||
                         member.data?.auth?.email;
        
        if (!userEmail) {
            showError('Unable to retrieve your email address. Please log out and log back in.');
            console.error('[Dashboard] Member object missing email:', member);
            return;
        }
        
        // Normalize email (case-insensitive matching) - matches backend verification
        const normalizedEmail = userEmail.toLowerCase().trim();
        
        try {
            const response = await fetch(`${API_BASE}/remove-site`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include',
                body: JSON.stringify({ 
                    site: site.trim(),
                    email: normalizedEmail,
                    subscription_id: subscriptionId ? subscriptionId.trim() : null
                })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                // Handle specific error codes from backend
                const errorCode = data.error;
                const errorMessage = data.message || 'Failed to unsubscribe site';
                
                // Map specific error codes to user-friendly messages
                let userMessage = errorMessage;
                if (errorCode === 'memberstack_authentication_failed') {
                    userMessage = 'Authentication failed. Please log out and log back in to continue.';
                } else if (errorCode === 'memberstack_email_missing') {
                    userMessage = 'Your account email is missing. Please contact support.';
                } else if (errorCode === 'email_mismatch') {
                    userMessage = 'Email verification failed. Please ensure you are logged in with the correct account.';
                } else if (errorCode === 'memberstack_account_deleted') {
                    userMessage = 'Your account has been deleted. Please contact support.';
                } else if (errorCode === 'memberstack_account_inactive') {
                    userMessage = 'Your account is inactive. Please contact support.';
                } else if (errorCode === 'memberstack_verification_failed') {
                    userMessage = 'Account verification failed. Please log out and log back in.';
                } else if (errorCode === 'site_not_found') {
                    userMessage = `Site "${site}" was not found in your subscriptions.`;
                } else if (errorCode === 'subscription_not_found') {
                    userMessage = 'Subscription not found. The subscription may have already been canceled.';
                } else if (errorCode === 'unauthorized') {
                    userMessage = 'You are not authorized to perform this action. Please log in again.';
                }
                
                throw new Error(userMessage);
            }
            
            // Use the message from backend which includes proration info based on subscription type
            const successMessage = data.message || 
                (data.is_individual_subscription 
                    ? `Site "${site}" has been unsubscribed successfully! This license has its own individual subscription, so canceling it will cancel the entire subscription (no proration). The subscription will remain active until the end of the current billing period.`
                    : `Site "${site}" has been unsubscribed successfully! The subscription has been canceled and will remain active until the end of the current billing period. Stripe will prorate the current period and future invoices will be reduced. The site will remain visible as inactive with its expiration date.`);
            
            showSuccess(successMessage);
            
            // Reload dashboard to show updated data (use normalized email for consistency)
            await loadDashboard(normalizedEmail);
        } catch (error) {
            console.error('[Dashboard] Error unsubscribing site:', error);
            
            // Show user-friendly error message
            const errorMessage = error.message || 'Failed to unsubscribe site. Please try again or contact support.';
            showError(errorMessage);
        }
    }
    
    // Load licenses
    async function loadLicenses(userEmail) {
        const licensesContainer = document.getElementById('licenses-container');
        if (!licensesContainer) {
            console.error('[Dashboard] Licenses container not found');
            return;
        }
        
        // Validate email before making API call
        if (!userEmail || !userEmail.includes('@')) {
            console.error('[Dashboard] ❌ Invalid email for licenses API call:', userEmail);
            licensesContainer.innerHTML = '<div style="color: #f44336; padding: 20px;">Invalid email address</div>';
            return;
        }
        
        licensesContainer.innerHTML = '<div style="text-align: center; padding: 40px; color: #666;">Loading licenses...</div>';
        
        
        try {
            // Try email-based endpoint first
            let response = await fetch(`${API_BASE}/licenses?email=${encodeURIComponent(userEmail)}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include'
            });
            
            
            // If email endpoint doesn't work, try with session cookie
            if (!response.ok && response.status === 401) {
                response = await fetch(`${API_BASE}/licenses`, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    credentials: 'include'
                });
            }
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error('[Dashboard] ❌ Licenses API Error:', response.status, errorText);
                throw new Error(`Failed to load licenses: ${response.status}`);
            }
            
            const data = await response.json();
            displayLicenses(data.licenses || []);
        } catch (error) {
            console.error('[Dashboard] ❌ Error loading licenses:', error);
            console.error('[Dashboard] Error details:', error.message);
            const licensesContainer = document.getElementById('licenses-container');
            if (licensesContainer) {
                licensesContainer.innerHTML = `<div style="color: #f44336; padding: 20px;">
                    Failed to load licenses.<br>
                    <small>Email: ${userEmail}</small><br>
                    <small>Error: ${error.message}</small>
                </div>`;
            }
        }
    }
    
    // Display licenses
    function displayLicenses(licenses) {
        const container = document.getElementById('licenses-container');
        if (!container) return;
        
        if (licenses.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 40px; color: #999;">
                    <p>No license keys yet. Licenses will appear here after payment.</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = licenses.map(license => `
            <div class="license-item" style="
                background: #f5f5f5;
                border-radius: 8px;
                padding: 15px;
                margin-bottom: 10px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            ">
                <div>
                    <div class="license-key" style="
                        font-family: 'Courier New', monospace;
                        font-size: 14px;
                        color: #333;
                        font-weight: bold;
                    ">${license.license_key}</div>
                    <div style="font-size: 12px; color: #999; margin-top: 5px;">
                        Status: ${license.status} | 
                        Created: ${new Date(license.created_at * 1000).toLocaleDateString()}
                    </div>
                </div>
                <button class="copy-license-button" data-key="${license.license_key}" style="
                    background: #667eea;
                    color: white;
                    border: none;
                    padding: 6px 12px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    transition: background 0.3s;
                " onmouseover="this.style.background='#5568d3'" onmouseout="this.style.background='#667eea'">Copy</button>
            </div>
        `).join('');
        
        // Attach event listeners to copy buttons
        container.querySelectorAll('.copy-license-button').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-key');
                copyLicense(key);
            });
        });
    }
    
    // Copy license key
    function copyLicense(key) {
        navigator.clipboard.writeText(key).then(() => {
            showSuccess('License key copied to clipboard!');
        }).catch(err => {
            showError('Failed to copy license key');
        });
    }
    
    // Logout function
    async function logout() {
        try {
            const memberstack = await waitForSDK();
            if (memberstack && memberstack.logout) {
                await memberstack.logout();
            }
            
            // Redirect to login page
            window.location.href = '/';
        } catch (error) {
            console.error('[Dashboard] Logout error:', error);
            // Still redirect even if logout fails
            window.location.href = '/';
        }
    }
    
    // Show/hide dashboard content based on login status
    function toggleDashboardVisibility(isLoggedIn) {
        const dashboardContainer = document.getElementById('dashboard-container');
        const loginPrompt = document.getElementById('login-prompt');
        
        
        if (dashboardContainer) {
            dashboardContainer.style.display = isLoggedIn ? 'block' : 'none';
        } else {
            console.error('[Dashboard] ❌ Dashboard container NOT found!');
            console.error('[Dashboard] This means createDashboardHTML() may have failed');
        }
        
        if (loginPrompt) {
            loginPrompt.style.display = isLoggedIn ? 'none' : 'block';
        } else {
            console.warn('[Dashboard] ⚠️ Login prompt NOT found (this is okay if not needed)');
        }
        
    }
    
    // Wait for Memberstack to be fully ready
    async function waitForMemberstackReady() {
        
        // Method 1: Wait for $memberstackReady flag
        let attempts = 0;
        const maxAttempts = 60; // 30 seconds
        
        while (attempts < maxAttempts) {
            if (window.$memberstackReady === true) {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
            attempts++;
            
            if (attempts % 10 === 0) {
            }
        }
        
        // Method 2: Wait for SDK object to be available
        const memberstack = await waitForSDK();
        if (!memberstack) {
            console.error('[Dashboard] ❌ SDK not available after waiting');
            return false;
        }
        
        // Method 3: Wait for onReady promise if available
        if (memberstack.onReady && typeof memberstack.onReady.then === 'function') {
            try {
                await Promise.race([
                    memberstack.onReady,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
                ]);
            } catch (error) {
                console.warn('[Dashboard] ⚠️ SDK onReady timeout, but continuing...');
            }
        }
        
        // Additional wait to ensure everything is initialized
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        return true;
    }
    
    // Initialize dashboard
    async function initializeDashboard() {
        
        // Create dashboard HTML structure first (always show it)
        try {
            createDashboardHTML();
        } catch (error) {
            console.error('[Dashboard] ❌ Error creating dashboard HTML:', error);
            showError('Failed to create dashboard. Please refresh the page.');
            return;
        }
        
        // Show dashboard by default (will hide if not logged in)
        // Don't hide immediately - wait for session check
        const dashboardContainer = document.getElementById('dashboard-container');
        if (dashboardContainer) {
            dashboardContainer.style.display = 'block';
        } else {
            console.error('[Dashboard] ❌ Dashboard container not found after creation!');
        }
        
        // Check if Memberstack SDK script tag exists
        const scriptTag = document.querySelector('script[data-memberstack-app]');
        if (!scriptTag) {
            console.error('[Dashboard] ❌ Memberstack script tag not found!');
            console.error('[Dashboard] Waiting 5 seconds and checking again...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Check again
            const retryScriptTag = document.querySelector('script[data-memberstack-app]');
            if (!retryScriptTag) {
                console.error('[Dashboard] ❌ Memberstack script tag still not found after waiting');
                showError('Authentication system not configured. Please add Memberstack SDK to HEAD section.');
                toggleDashboardVisibility(false);
                return;
            }
        } else {
            const appId = scriptTag.getAttribute('data-memberstack-app');
        }
        
        // Wait for Memberstack to be fully ready
        const isReady = await waitForMemberstackReady();
        if (!isReady) {
            console.error('[Dashboard] ❌ Memberstack not ready after waiting');
            showError('Memberstack SDK is taking too long to load. Please refresh the page.');
            toggleDashboardVisibility(false);
            return;
        }
        
        // Try checking session multiple times (retry logic)
        let member = null;
        let retryCount = 0;
        const maxRetries = 8; // Increased retries
        
        
        while (!member && retryCount < maxRetries) {
            
            member = await checkMemberstackSession();
            
            if (!member) {
                retryCount++;
                if (retryCount < maxRetries) {
                    const waitTime = 3000; // 3 seconds between retries
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
            } else {
            }
        }
        
        if (!member) {
            
            // Try one more direct check
            if (window.$memberstackDom && window.$memberstackDom.memberstack) {
                try {
                    const directMember = await window.$memberstackDom.memberstack.getCurrentMember();
                } catch (e) {
                    console.error('[Dashboard] Direct member check error:', e);
                }
            }
            
            
            // Only hide dashboard if we're sure user is not logged in
            toggleDashboardVisibility(false);
            
            // Show a message to user
            const dashboardContainerCheck = document.getElementById('dashboard-container');
            if (dashboardContainerCheck) {
                // Keep container visible but show login prompt
                const loginPrompt = document.getElementById('login-prompt');
                if (loginPrompt) {
                    loginPrompt.style.display = 'block';
                }
            }
            return;
        }
        
        // User is logged in - ensure dashboard is visible
        
        // Extract email from member object (check multiple locations)
        let userEmail = member.normalizedEmail || 
                       member.email || 
                       member._email ||
                       (member.data && (member.data.email || member.data.auth?.email)) ||
                       '';
        
        // Normalize email
        if (userEmail) {
            userEmail = userEmail.toString().toLowerCase().trim();
        }
        
        if (!userEmail) {
            console.error('[Dashboard] ❌ No email found in member object!');
            console.error('[Dashboard] Member object structure:', JSON.stringify(member, null, 2));
            showError('Unable to retrieve user email. Please log out and log in again.');
            // Still show dashboard but with error
            const dashboardContainerError = document.getElementById('dashboard-container');
            if (dashboardContainerError) {
                dashboardContainerError.style.display = 'block';
                dashboardContainerError.style.visibility = 'visible';
            }
            return;
        }
        
        // Validate email format one more time
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(userEmail)) {
            console.error('[Dashboard] ❌ Invalid email format:', userEmail);
            showError('Invalid email format. Please contact support.');
            // Still show dashboard but with error
            const dashboardContainerInvalid = document.getElementById('dashboard-container');
            if (dashboardContainerInvalid) {
                dashboardContainerInvalid.style.display = 'block';
                dashboardContainerInvalid.style.visibility = 'visible';
            }
            return;
        }
        
        
        // FIRST: Force dashboard to be visible immediately
        toggleDashboardVisibility(true);
        
        // Double-check and force visibility
        const dashboardContainerForce = document.getElementById('dashboard-container');
        if (dashboardContainerForce) {
            dashboardContainerForce.style.display = 'block';
            dashboardContainerForce.style.visibility = 'visible';
            dashboardContainerForce.style.opacity = '1';
        } else {
            console.error('[Dashboard] ❌ Dashboard container not found after login!');
        }
        
        // Hide login prompt if it exists
        const loginPrompt = document.getElementById('login-prompt');
        if (loginPrompt) {
            loginPrompt.style.display = 'none';
        }
        
        // Store email globally for use by other functions
        currentUserEmail = userEmail;
        
        // Load dashboard data
        
        try {
            await Promise.all([
                loadDashboard(userEmail),
                loadLicenses(userEmail)
            ]);
        } catch (error) {
            console.error('[Dashboard] ❌ Error loading dashboard data:', error);
            showError('Failed to load dashboard data. Please refresh the page.');
        }
        
        // Attach event listeners
        // Legacy add-site button (if exists - for backward compatibility)
        const addSiteButton = document.getElementById('add-site-button');
        if (addSiteButton) {
            addSiteButton.addEventListener('click', () => addSite(userEmail));
        }
        
        // Purchase quantity button
        // Option 2: No subscription selection needed - creates new subscriptions
        const purchaseQuantityButton = document.getElementById('purchase-quantity-button');
        if (purchaseQuantityButton) {
            purchaseQuantityButton.addEventListener('click', () => {
                const quantityInput = document.getElementById('license-quantity-input');
                const quantity = quantityInput ? parseInt(quantityInput.value) : 1;
                
                // No subscription selection required - we're creating NEW subscriptions (Option 2)
                if (quantity < 1) {
                    showError('Quantity must be at least 1');
                    return;
                }
                handleQuantityPurchase(userEmail, quantity);
            });
        }

        // Generate missing licenses button
        const generateMissingLicensesButton = document.getElementById('generate-missing-licenses-button');
        if (generateMissingLicensesButton) {
            generateMissingLicensesButton.addEventListener('click', async () => {
                const button = generateMissingLicensesButton;
                const originalText = button.textContent;
                
                try {
                    button.disabled = true;
                    button.textContent = 'Generating...';
                    
                    const response = await fetch(`${API_BASE}/generate-missing-licenses`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                            email: userEmail
                        })
                    });

                    const data = await response.json();

                    if (!response.ok) {
                        throw new Error(data.error || data.message || 'Failed to generate licenses');
                    }

                    if (data.totalGenerated > 0) {
                        showSuccess(`Successfully generated ${data.totalGenerated} license key(s)! Refreshing...`);
                        // Reload licenses
                        if (userEmail) {
                            await loadLicenseKeys(userEmail);
                        }
                    } else {
                        showSuccess('All licenses are already generated. No missing licenses found.');
                    }
                } catch (error) {
                    console.error('[Dashboard] Error generating missing licenses:', error);
                    showError('Failed to generate licenses: ' + error.message);
                } finally {
                    button.disabled = false;
                    button.textContent = originalText;
                }
            });
        }
        
        // Logout button
        const logoutButton = document.getElementById('logout-button');
        if (logoutButton) {
            logoutButton.addEventListener('click', logout);
        }
        
        // Allow Enter key in legacy add site form (if exists)
        const siteInput = document.getElementById('new-site-input');
        if (siteInput && addSiteButton) {
            siteInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    addSiteButton.click();
                }
            });
        }
        
        // Allow Enter key in subscription add-site forms (added dynamically)
        setTimeout(() => {
            document.querySelectorAll('[id^="new-site-input-"]').forEach(input => {
                input.addEventListener('keypress', async (e) => {
                    if (e.key === 'Enter') {
                        const subscriptionId = input.id.replace('new-site-input-', '');
                        const addButton = document.querySelector(`[data-subscription-id="${subscriptionId}"].add-site-to-subscription`);
                        if (addButton) {
                            addButton.click();
                        }
                    }
                });
            });
        }, 1000);
        
    }
    
    // Expose functions to global scope (for inline onclick handlers if needed)
    window.addSite = async function() {
        const member = await checkMemberstackSession();
        if (!member) {
            showError('Not authenticated');
            return;
        }
        const userEmail = member.email || member._email;
        await addSite(userEmail);
    };
    
    window.removeSite = async function(site, subscriptionId) {
        await removeSite(site, subscriptionId);
    };
    
    window.copyLicense = function(key) {
        copyLicense(key);
    };
    
    window.logout = async function() {
        await logout();
    };
    
    // Initialize when page loads
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeDashboard);
    } else {
        initializeDashboard();
    }
})();
