<?php
class ModelExtensionHudoorApi extends Model {
	public function countRecords() {
		$query = $this->db->query("SELECT COUNT(*) AS total FROM `" . DB_PREFIX . "hudoor_record`");

		return (int)$query->row['total'];
	}

	public function syncEmployees($employees, $full) {
		$ids = array();

		foreach ($employees as $e) {
			$ids[] = "'" . $this->db->escape($e['id']) . "'";

			$this->db->query("INSERT INTO `" . DB_PREFIX . "hudoor_employee` SET
				`employee_id` = '" . $this->db->escape($e['id']) . "',
				`name` = '" . $this->db->escape($e['name']) . "',
				`code` = '" . $this->db->escape($e['code']) . "',
				`active` = '1',
				`date_modified` = NOW()
				ON DUPLICATE KEY UPDATE
				`name` = VALUES(`name`), `code` = VALUES(`code`), `active` = '1', `date_modified` = NOW()");
		}

		if ($full) {
			if ($ids) {
				$this->db->query("UPDATE `" . DB_PREFIX . "hudoor_employee` SET `active` = '0' WHERE `employee_id` NOT IN (" . implode(',', $ids) . ")");
			} else {
				$this->db->query("UPDATE `" . DB_PREFIX . "hudoor_employee` SET `active` = '0'");
			}
		}
	}

	public function addRecord($r) {
		$this->db->query("INSERT IGNORE INTO `" . DB_PREFIX . "hudoor_record` SET
			`record_id` = '" . $this->db->escape($r['record_id']) . "',
			`employee_id` = '" . $this->db->escape($r['employee_id']) . "',
			`employee_name` = '" . $this->db->escape($r['employee_name']) . "',
			`employee_code` = '" . $this->db->escape($r['employee_code']) . "',
			`type` = '" . $this->db->escape($r['type']) . "',
			`time_local` = '" . $this->db->escape($r['time_local']) . "',
			`ts` = '" . sprintf('%.0f', $r['ts']) . "',
			`device` = '" . $this->db->escape($r['device']) . "',
			`date_added` = NOW()");
	}
}
