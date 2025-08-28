
const { v2: cloudinary } = require('cloudinary');
const axios = require('axios');

cloudinary.config({
  cloud_name: 'ddmzeqpkc',
  api_key: '467773421832135',
  api_secret: 'Iaa3QHrnAlB3O1vSBjShTbd4zuE'
});

async function testAfterSecurityFix() {
  console.log(' Testing Cloudinary after security fix by saikiran11461 at 2025-08-25 05:27:25');
  
  try {
  
    console.log('\n Test 1: Uploading new test certificate...');
    
    const fs = require('fs');
    const path = require('path');
    
    const testPath = path.join(__dirname, 'test-security-fix.pdf');
    fs.writeFileSync(testPath, '%PDF-1.4\ntest after security fix');
    
    const uploadResult = await cloudinary.uploader.upload(testPath, {
      resource_type: 'raw',
      public_id: 'certificates/TEST-SECURITY-FIX-saikiran11461',
      access_mode: 'public',
      type: 'upload',
      overwrite: true,
      invalidate: true
    });
    
    console.log(' Upload successful:', uploadResult.secure_url);
    
   
    console.log('\n🔗 Test 2: Testing URL access...');
    
    const testUrl = uploadResult.secure_url;
    console.log(`Testing: ${testUrl}`);
    
    try {
      const response = await axios.head(testUrl, { timeout: 10000 });
      console.log(' SUCCESS! URL is now accessible:', response.status);
      console.log(' Content-Type:', response.headers['content-type']);
      console.log(' Content-Length:', response.headers['content-length']);
      
    
      const downloadResponse = await axios.get(testUrl, {
        responseType: 'arraybuffer',
        timeout: 10000
      });
      
      console.log(' Download successful! Size:', downloadResponse.data.byteLength, 'bytes');
      
    
      fs.unlinkSync(testPath);
      
      console.log('\n🎉 CLOUDINARY IS NOW WORKING!');
      console.log(' Security settings have been fixed');
      console.log(' Raw files are now publicly accessible');
      console.log(' Your certificate system should work now');
      
      return true;
      
    } catch (accessError) {
      console.log(' URL still not accessible:', accessError.response?.status);
      console.log(' Security settings may need more time to propagate');
      console.log(' Wait 5 more minutes and try again');
      
      fs.unlinkSync(testPath);
      return false;
    }
    
  } catch (error) {
    console.error(' Test failed:', error);
    return false;
  }
}


async function testExistingCertificate() {
  console.log('\n🧪 Testing existing certificate from your uploads...');
  

  const existingCertUrls = [
    'https://res.cloudinary.com/ddmzeqpkc/raw/upload/certificates/test-auth-saikiran11461.pdf',
    'https://res.cloudinary.com/ddmzeqpkc/raw/upload/v1756099575/certificates/TEST-ACL-FIX-saikiran11461.pdf'
  ];
  
  for (const url of existingCertUrls) {
    console.log(`\n🔗 Testing existing: ${url}`);
    
    try {
      const response = await axios.head(url, { timeout: 5000 });
      console.log(' Existing certificate now accessible:', response.status);
      return true;
    } catch (error) {
      console.log(' Still not accessible:', error.response?.status);
    }
  }
  
  return false;
}

async function runAllTests() {
  const newTest = await testAfterSecurityFix();
  const existingTest = await testExistingCertificate();
  
  if (newTest || existingTest) {
    console.log('\n CLOUDINARY SECURITY FIX SUCCESSFUL!');
    console.log(' Your certificate system is ready to use');
  } else {
    console.log('\n⏳ Security settings may need more time');
    console.log(' Try again in 5 minutes');
  }
}

runAllTests();