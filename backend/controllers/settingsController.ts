import { Request, Response } from 'express';
import { db } from "../db";

// GET settings
export const getSettings = async (req: Request, res: Response) => {
  try {
    const [results]: any = await db.query('SELECT * FROM system_settings WHERE id = 1');
    
    // If no settings exist yet, create default settings
    if (!results || (Array.isArray(results) && results.length === 0)) {
      await db.query(
        `INSERT INTO system_settings (id, clinic_name, clinic_email, clinic_phone, clinic_address, dark_mode) 
         VALUES (1, 'HealthCare Clinic', '', '', '', FALSE)`
      );
      
      const [newResults]: any = await db.query('SELECT * FROM system_settings WHERE id = 1');
      return res.json(newResults[0] || {});
    }
    
    res.json(results[0]);
  } catch (err: any) {
    console.error('Database error:', err);
    res.status(500).json({ error: err.message });
  }
};

// UPDATE settings
export const updateSettings = async (req: Request, res: Response) => {
  try {
    // Map Frontend keys to Database columns
    const fieldMapping: Record<string, string> = {
      clinicName: 'clinic_name',
      clinicEmail: 'clinic_email',
      clinicPhone: 'clinic_phone',
      clinicAddress: 'clinic_address',
      clinicLogo: 'clinic_logo',
      darkMode: 'dark_mode',
      primaryColor: 'primary_color',
      emailNotifications: 'email_notifications',
      smsNotifications: 'sms_notifications',
      pushNotifications: 'push_notifications',
      reminderHoursBefore: 'reminder_hours_before',
      maxAppointmentsPerDay: 'max_appointments_per_day',
      defaultAppointmentDuration: 'default_appointment_duration',
      allowSameDayBooking: 'allow_same_day_booking',
      autoApproveThreshold: 'auto_approve_threshold'
    };

    const updates: string[] = [];
    const values: any[] = [];

    // Loop through the body to see what needs updating
    Object.keys(fieldMapping).forEach((key) => {
      if (req.body[key] !== undefined) {
        updates.push(`${fieldMapping[key]} = ?`);
        
        // Convert booleans to 1/0 for MySQL
        if (typeof req.body[key] === 'boolean') {
          values.push(req.body[key] ? 1 : 0);
        } else {
          values.push(req.body[key]);
        }
      }
    });

    if (updates.length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    values.push(1); // WHERE id = 1
    const sql = `UPDATE system_settings SET ${updates.join(', ')} WHERE id = ?`;

    await db.query(sql, values);
    
    res.json({ 
      success: true,
      message: 'Settings updated successfully!' 
    });
  } catch (err: any) {
    console.error('Update error:', err);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
};