// server/controllers/fmsController.js
const FmsTemplate = require('../models/FmsTemplate');
const FmsInstance = require('../models/FmsInstance'); 
const Employee = require('../models/Employee');
const axios = require('axios');
const moment = require('moment');

const FmsHistory = require('../models/FmsHistory');


const { addWorkingTime } = require('../utils/timeCalculator');




/**
 * PHASE 1: CREATE NEW FLOW BLUEPRINT
 * Saves the mapping of Google Sheet columns to factory tasks.
 */
exports.createFmsTemplate = async (req, res) => {
      // Ensure nodes are sorted
req.body.nodes = req.body.nodes.sort((a, b) => a.stepIndex - b.stepIndex);

// Validate nodes
for (const node of req.body.nodes) {
  if (!node.nodeName || !node.emailColumn) {
    return res.status(400).json({ message: "Invalid node data" });
  }
}
  try {
    const template = new FmsTemplate(req.body);
    await template.save();
    res.status(201).json({ message: "FMS Blueprint Synchronized", template });
  } catch (error) {
    res.status(500).json({ message: "Blueprint Creation Failed", error: error.message });
  }
};

/**
 * PHASE 1: FETCH ALL TENANT FLOWS
 */
exports.getTenantTemplates = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const templates = await FmsTemplate.find({ tenantId });
    res.status(200).json(templates);
  } catch (error) {
    res.status(500).json({ message: "Fetch Failed", error: error.message });
  }
};

/**
 * NEW: FETCH LIVE INSTANCES
 * Required for the FmsDashboard 'Live Production Tracker' table.
 */
exports.getTenantInstances = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const instances = await FmsInstance.find({ tenantId }).sort({ createdAt: -1 });
    res.status(200).json(instances);
  } catch (error) {
    res.status(500).json({ message: "Instance Fetch Failed", error: error.message });
  }
};

/**
 * NEW: INITIALIZE FLOW (TRIGGER)
 * This starts the clock for an order. Can be triggered manually or via Sheet.
 */
exports.initializeFlow = async (req, res) => {
  try {
    const { templateId, orderIdentifier, tenantId, sheetRowId } = req.body;
    const template = await FmsTemplate.findById(templateId);
    if (!template) return res.status(404).json({ message: "Blueprint not found" });

    // 1. Duplicate Check: Ensure we don't start the same order twice
    const existing = await FmsInstance.findOne({ orderIdentifier, tenantId });
    if (existing) return res.status(200).json({ message: "Order already active", instance: existing });

    // 2. Calculate deadline for Step 1 based on its offset (e.g., +2 hours from now)
    const firstNode = template.nodes.find(n => n.stepIndex === 0) || template.nodes[0];
    
    //const deadline = moment().add(firstNode.offsetValue, firstNode.offsetUnit).toDate();




    const deadline = addWorkingTime(
  new Date(),
  firstNode.offsetValue,
  firstNode.offsetUnit,
  template.workingHours
  );




    const newInstance = new FmsInstance({
      tenantId,
      templateId,
      orderIdentifier,
      sheetRowId, // ✅ ADD THIS
      steps: template.nodes.map((node) => ({
        nodeName: node.nodeName,
        stepIndex: node.stepIndex,
        // Only the first step gets a deadline initially

        //assignedTo: row?.[node.email] || node.emailColumn, // 🔥 KEY FIX
        assignedTo: node.emailColumn ,



        inputType: node.inputType, // ✅ NEW
  
        plannedDeadline: node.stepIndex === 0 ? deadline : null, 
        status: 'Pending'
      })),
      currentStepIndex: 0
    });

    await newInstance.save();




    await FmsHistory.create({
  instanceId: newInstance._id,
  templateId: newInstance.templateId._id,
  stepIndex: 0,
  nodeName: firstNode.nodeName,
  orderIdentifier,
  action: 'CREATED',
  assignedTo: firstNode.emailColumn
});



    res.status(201).json({ message: "Flow Clock Started", instance: newInstance });
  } catch (error) {
    res.status(500).json({ message: "Initialization Failed", error: error.message });
  }
};

/**
 * NEW: EXECUTE/COMPLETE STEP
 * Marks current step as done, calculates delay, and plans the NEXT step's deadline.
 */
exports.executeStep = async (req, res) => {
  try {


    const { instanceId } = req.params;
    //const { remarks } = req.body;
    

    const { remarks, decision, action } = req.body;
    const instance = await FmsInstance.findById(instanceId).populate('templateId');
    if (!instance) return res.status(404).json({ message: "Live instance not found" });

    const currentIndex = instance.currentStepIndex;
    const now = new Date();
    const currentStep = instance.steps.find(s => s.stepIndex === currentIndex);

    if (!currentStep) throw new Error("Current step node not found in instance");





    
    if (currentStep.isPaused && !action) {
  return res.status(400).json({
    message: "Step is paused. Resume first."
  });
}

currentStep.remarks = remarks || "";






    


    const nodeTemplate = instance.templateId.nodes.find(n => n.stepIndex === currentIndex);




    // If this is YES/NO step
  if (nodeTemplate.inputType === 'yesno') {

  // ❌ NO → PAUSE FLOW
  if (decision === 'No') {
    currentStep.decision = 'No';
    currentStep.isPaused = true;
    currentStep.pausedAt = new Date();
    currentStep.status = 'Pending'; // still pending

    await instance.save();

    
    await FmsHistory.create({
  instanceId,
  templateId: instance.templateId._id,
  stepIndex: currentIndex,
  action: 'PAUSED',
  newValue: { reason: remarks }
});



    return res.status(200).json({
      message: "Flow Paused (No Selected)",
      instance
    });

  }

  // 🔄 CONTINUE
  if (action === 'continue') {
    if (!currentStep.isPaused) {
      return res.status(400).json({ message: "Step is not paused" });
    }

    currentStep.isPaused = false;
    currentStep.decision = 'Yes';

    const now = new Date();

    // 🔥 RE-CALCULATE DEADLINES FROM THIS POINT
    let baseTime = now;

    for (let i = currentStep.stepIndex; i < instance.steps.length; i++) {
      const step = instance.steps.find(s => s.stepIndex === i);
      const templateNode = instance.templateId.nodes.find(n => n.stepIndex === i);

      if (!step || !templateNode) continue;

      const newDeadline = addWorkingTime(
        baseTime,
        templateNode.offsetValue,
        templateNode.offsetUnit,
        instance.templateId.workingHours
      );

      step.plannedDeadline = newDeadline;
      baseTime = newDeadline;
    }

    await instance.save();


    await FmsHistory.create({
  instanceId,
  templateId: instance.templateId._id,
  stepIndex: currentIndex,
  action: 'RESUMED'
});

    return res.status(200).json({
      message: "Flow Resumed & Deadlines Recalculated",
      instance
    });
  }

  // ✅ YES → proceed normally
  if (decision === 'Yes') {
    currentStep.decision = 'Yes';


    currentStep.isPaused = false;
  }
  }





  




    // 1. Mark Current Step as Completed
    currentStep.actualCompletedAt = now;
    currentStep.status = 'Completed';

    // 2. Calculate Delay (if 'now' is past the planned deadline)
    if (currentStep.plannedDeadline && now > currentStep.plannedDeadline) {
      currentStep.delayInMinutes = moment(now).diff(moment(currentStep.plannedDeadline), 'minutes');
    }

    // 3. Chain Logic: Plan the NEXT Step
    const nextIndex = currentIndex + 1;
    const nextNodeTemplate = instance.templateId.nodes.find(n => n.stepIndex === nextIndex);
    if (nextNodeTemplate) {
      // The NEXT deadline is: Completion Time of previous step + Next Step's Offset
      
      
      
      /* const nextDeadline = moment(now)
        .add(nextNodeTemplate.offsetValue, nextNodeTemplate.offsetUnit)
        .toDate();

        */


      const nextDeadline = addWorkingTime(
        now,
        nextNodeTemplate.offsetValue,
        nextNodeTemplate.offsetUnit,
        instance.templateId.workingHours
      );




      
      const nextStep = instance.steps.find(s => s.stepIndex === nextIndex);
      if (nextStep) {
        nextStep.plannedDeadline = nextDeadline;
        instance.currentStepIndex = nextIndex;
      }
    } else {
      // No more steps found in blueprint
      instance.isFullyCompleted = true;
    }


   // const nodeTemplate = instance.templateId.nodes.find(n => n.stepIndex === currentIndex);

await exports.updateSheetStatus(
  instance.templateId._id,
  //instance.orderIdentifier,

  instance.sheetRowId,   // ✅ FIX
  nodeTemplate.sheetColumn || nodeTemplate.nodeName,
  "Completed"
);




await FmsHistory.create({
  instanceId,
  templateId: instance.templateId._id,
  stepIndex: currentIndex,
  nodeName: currentStep.nodeName,
  orderIdentifier: instance.orderIdentifier,
  action: 'COMPLETED',
  performedBy: currentStep.assignedTo,
  newValue: {
    completedAt: now,
    delay: currentStep.delayInMinutes
  }
});

    await instance.save();
    res.status(200).json({ message: "Step Authorized, Next Step Planned", instance });
  } catch (error) {
    res.status(500).json({ message: "Execution Failed", error: error.message });
  }
};


exports.deleteFmsTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;
    await FmsTemplate.findByIdAndDelete(templateId);
    
    // Optional: Also delete live instances associated with this template
    await FmsInstance.deleteMany({ templateId });

    res.status(200).json({ message: "Blueprint and associated telemetry purged." });
  } catch (error) {
    res.status(500).json({ message: "Deletion Failed", error: error.message });
  }
};


/**
 * PHASE 3: THE FLOW RUNNER (SCANNER) - UPDATED
 * Scans the Google Sheet for NEW orders and initializes the time-based flow.
 */
exports.syncFmsOrders = async (req, res) => {
    try {
      const { templateId } = req.params;
      const template = await FmsTemplate.findById(templateId);
      if (!template) return res.status(404).json({ message: "Template not found" });
  
      const sheetResponse = await axios.get(template.scriptUrl, {
        params: { operation: 'readSheet', sheetId: template.googleSheetId, tabName: template.tabName }
      });
  
      const rows = sheetResponse.data;
      if (!rows || rows.length === 0) return res.status(200).json({ message: "No rows found in sheet" });
  
      const dispatchLog = [];
      const actualHeaders = Object.keys(rows[0]);
      
      // ID Matching Logic
      const idKey = actualHeaders.find(h => 
        h.toLowerCase() === (template.uniqueIdentifierColumn || '').toLowerCase() || 
        h.toLowerCase() === 'order id' ||
        h.toLowerCase() === 'timestamp'
      ) || actualHeaders[0];

     /* const idKey = template.uniqueIdentifierColumn;

if (!rows[0][idKey]) {
  throw new Error(`Invalid ID column: ${idKey}`);
}
*/

  
      let newOrdersCount = 0;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];


        const orderId = row[idKey]?.toString().trim();

        if (!orderId || orderId.length < 3) continue;


        /*const orderId = row[idKey]?.toString();
        if (!orderId) continue;*/

        // 1. Check if Order is already being tracked in FmsInstance
        const existing = await FmsInstance.findOne({ orderIdentifier: orderId, tenantId: template.tenantId });
        if (existing) continue;

        // 2. Initialize Flow Clock for new Orders found in sheet
        const firstNode = template.nodes.find(n => n.stepIndex === 0) || template.nodes[0];
        
        //const deadline = moment().add(firstNode.offsetValue, firstNode.offsetUnit).toDate();




        const deadline = addWorkingTime(
          new Date(),
          firstNode.offsetValue,
          firstNode.offsetUnit,
          template.workingHours
        );


        


        const newInstance = new FmsInstance({
          tenantId: template.tenantId,
          templateId: template._id,
          orderIdentifier: orderId,
          sheetRowId: i + 2, // assuming row 1 = header
          steps: template.nodes.map((node) => ({
            nodeName: node.nodeName,
            stepIndex: node.stepIndex,



            assignedTo: row?.[node.emailColumn] || node.emailColumn, // 🔥 KEY FIX


            inputType: node.inputType, 


            plannedDeadline: node.stepIndex === 0 ? deadline : null, 
            status: 'Pending'
          })),
          currentStepIndex: 0
        });

        await newInstance.save();
        newOrdersCount++;
        dispatchLog.push({ orderId, status: "Initialized" });
      }



      console.log("SHEET SAMPLE:", rows.slice(0, 3));



  
      res.status(200).json({ message: "Sync Success", count: newOrdersCount, log: dispatchLog });
    } catch (error) {
      console.error("FMS Sync Crash:", error.message);
      res.status(500).json({ message: "Internal Sync Error", detail: error.message });
    }
  };

/**
 * PHASE 2: DYNAMIC WRITE-BACK ENGINE - PRESERVED
 */
exports.updateSheetStatus = async (templateId, rowId, columnHeader, statusValue) => {
  try {
    const template = await FmsTemplate.findById(templateId);
    if (!template) throw new Error("Template not found for write-back");

    await axios.post(template.scriptUrl, {
      operation: 'updateCell',
      sheetId: template.googleSheetId,
      idValue: rowId,

      //idValue: instance.sheetRowId,
      header: columnHeader,
      value: statusValue
    });
  } catch (err) {
    console.error("Sheet Write-Back Failed:", err.message);
  }
};



/*

exports.getMyMissions = async (req, res) => {
  try {
    const { email } = req.params;

    // Find all instances
    const instances = await FmsInstance.find()
      .populate('templateId')
      .sort({ createdAt: -1 });

    const missions = [];

    for (const instance of instances) {
      const currentIndex = instance.currentStepIndex;

      const currentStep = instance.steps.find(
        s => s.stepIndex === currentIndex
      );

      const nodeTemplate = instance.templateId.nodes.find(
        n => n.stepIndex === currentIndex
      );

      // 🔥 MATCH USER
      if (nodeTemplate?.emailColumn === email) {
        missions.push({
          instanceId: instance._id,
          orderIdentifier: instance.orderIdentifier,
          nodeName: currentStep?.nodeName,
          stepIndex: currentIndex,
          plannedDeadline: currentStep?.plannedDeadline,
        });
      }
    }

    res.status(200).json(missions);

  } catch (error) {
    res.status(500).json({
      message: "Mission Fetch Failed",
      error: error.message
    });
  }
};*/



exports.getMyMissions = async (req, res) => {
  try {



    const { email } = req.params;

    const instances = await FmsInstance.find();

    const missions = [];

    instances.forEach(instance => {
          const currentStep = instance.steps.find(
            s => s.stepIndex === instance.currentStepIndex
        );

      const prevStep = instance.steps.find(
       s => s.stepIndex === instance.currentStepIndex - 1
      );
      instance.steps.forEach(step => {
        if (
          step.assignedTo === email &&
          step.stepIndex === instance.currentStepIndex &&
          step.status === 'Pending'
        ) {
          missions.push({
            instanceId: instance._id,
            orderIdentifier: instance.orderIdentifier,
            nodeName: step.nodeName,
            plannedDeadline: step.plannedDeadline,
            stepIndex: step.stepIndex,



          inputType: step.inputType,   // 🔥 ADD
          isPaused: step.isPaused ,
          
          
          
          // 🔥 ADD
           previousRemarks: prevStep?.remarks || null
          });
        }
      });
    });
    res.json(missions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};



exports.getInstanceHistory = async (req, res) => {
  try {
    const { instanceId } = req.params;

    const history = await FmsHistory.find({ instanceId })
      .sort({ timestamp: 1 });

    res.json(history);
  } catch (err) {
    res.status(500).json({ message: "History fetch failed" });
  }
};


exports.getFlowHistory = async (req, res) => {
  try {
    const { templateId } = req.params;

    const history = await FmsHistory.find({ templateId })
      .sort({ timestamp: 1 });

    res.json(history);
  } catch (err) {
    res.status(500).json({ message: "Flow history fetch failed" });
  }
};